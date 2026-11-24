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
// `drawRoot`: what a test draws instead of the menu (the model card), else the menu.
let drawRoot
const draw = () => {
  at = 0
  if (drawRoot !== undefined) return (rootTree = drawRoot())
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
    turnRunning: () => true,
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
    turnRunning: () => true,
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
    turnRunning: () => true,
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

// RFC 0030, Handoff note (2026-11-23), the lead's (1)/(7): an idle chat switches at once with no
// question; only while a reply runs does the menu ask "This stops the current reply…", and only
// its Switch sends stopReply. The host asks the same when it saw a reply the menu did not.
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const confirmOf = () => find(rootTree, node => node.type?.name === 'RouteConfirm')
const confirmParts = (confirm) => {
  const tree = confirm.type(confirm.props)
  return {
    text: find(tree, node => node.props.className === 'bt-model-confirm-text').children[0],
    buttons: nodes(tree, node => node.type === 'button').map(button => button.children[0]),
  }
}
const recorder = (extra = {}) => {
  const calls = { switched: [], updated: [] }
  globalThis.ACTIONS = {
    updateBot: (id, patch) => { calls.updated.push([id, patch]); return Promise.resolve() },
    switchRoute: (...args) => { calls.switched.push(args); return Promise.resolve() },
    refreshModels: () => {},
    ...extra,
  }
  return calls
}
const pickHaiku = () => {
  SLOTS = []
  const steps = openModels(rosterOf())
  click(steps, node => node.props.role === 'menuitemradio' && node.props.title === 'acp-claude/haiku')
}

test('C1: an idle crossing switches at once, with no question', async () => {
  for (const extra of [{}, { turnRunning: () => false }]) {
    const calls = recorder(extra)
    pickHaiku()
    await tick()
    assert.equal(confirmOf(), undefined)
    assert.deepEqual(JSON.parse(JSON.stringify(calls.switched)), [['b1', 'acp-claude/haiku', {}]])
    assert.deepEqual(calls.updated, [])
  }
})

test('C2: while a reply runs the menu asks, and Switch sends the crossing once with stopReply', async () => {
  const calls = recorder({ turnRunning: id => id === 'b1' })
  pickHaiku()
  const confirm = await confirmNow()
  assert.deepEqual(confirmParts(confirm), { text: 'This stops the current reply and continues on Claude Code.', buttons: ['Cancel', 'Switch'] })
  assert.deepEqual(calls.switched, [])
  confirm.props.onConfirm()
  await tick()
  assert.deepEqual(JSON.parse(JSON.stringify(calls.switched)), [['b1', 'acp-claude/haiku', {}, { stopReply: true }]])
  assert.deepEqual(calls.updated, [])
})

test('C3: Cancel on the running question sends nothing and changes nothing', async () => {
  const calls = recorder({ turnRunning: id => id === 'b1' })
  const roster = rosterOf()
  const before = JSON.stringify(roster.byId.b1)
  SLOTS = []
  click(openModels(roster), node => node.props.role === 'menuitemradio' && node.props.title === 'acp-claude/haiku')
  const confirm = await confirmNow()
  assert.deepEqual(confirmParts(confirm).buttons, ['Cancel', 'Switch'])
  confirm.props.onCancel()
  await tick()
  assert.equal(confirmOf(), undefined)
  assert.deepEqual(calls.switched, [])
  assert.deepEqual(calls.updated, [])
  assert.equal(JSON.stringify(roster.byId.b1), before)
})

test('C4: an idle crossing from Settings goes to its picker at once, as a crossing', async () => {
  const calls = recorder()
  const picked = []
  SLOTS = []
  const steps = openModels(rosterOf(), { onPick: (ref, options, ...rest) => { picked.push([ref, options, ...rest]); return Promise.resolve() } })
  click(steps, node => node.props.role === 'menuitemradio' && node.props.title === 'acp-claude/haiku')
  await tick()
  assert.equal(confirmOf(), undefined)
  assert.deepEqual(JSON.parse(JSON.stringify(picked)), [['acp-claude/haiku', { routeChange: true }]])
  assert.deepEqual(calls.switched, [])
  assert.deepEqual(calls.updated, [])
})

test('C5: the model card after the last turn asks while a reply runs; Switch picks once with stopReply', async () => {
  const chosen = []
  const actions = {
    turnRunning: id => id === 'b1',
    chooseModelInChat: (...args) => { chosen.push(args); return Promise.resolve() },
    updateBot() { assert.fail('the chat pick goes through chooseModelInChat') },
    refreshModels: () => {},
  }
  // A Bot whose agent is gone from the catalog: the card offers the models that can run.
  const bot = { id: 'b1', name: 'Ops', model: 'acp-codex/gone', appliedModel: 'acp-codex/gone' }
  const roster = { ...rosterOf(bot), models: rosterOf().models.slice(0, 1) }
  const props = { turn: { turn: 3 }, sessionId: 'b1', useRoster: select => select(roster), useSessions: select => select({ byId: { b1: { projectionValues: { turnOutline: [{ turn: 3 }] } } } }), actions }
  SLOTS = []
  drawRoot = () => {
    const seat = module.exports.ModelChoiceTail(props)
    return seat === null ? null : seat.type(seat.props)
  }
  try {
    draw()
    const chip = find(rootTree, node => node.type === 'button' && node.props.className === 'bt-model-chip' && String(node.props['aria-label']).startsWith('Flash'))
    assert.ok(chip, 'the card offers the native model')
    chip.props.onClick()
    await tick()
    const confirm = confirmOf()
    assert.ok(confirm, 'the card asks first')
    assert.deepEqual(confirmParts(confirm), { text: 'This stops the current reply and continues on Flash.', buttons: ['Cancel', 'Switch'] })
    assert.deepEqual(chosen, [])
    confirm.props.onConfirm()
    await tick()
    assert.deepEqual(JSON.parse(JSON.stringify(chosen)), [['b1', 'deepseek/flash', {}, { stopReply: true }]])
  } finally {
    drawRoot = undefined
    SLOTS = []
  }
})

test('C6 (guards): a model change inside one harness asks nothing while a reply runs; a Hermes crossing keeps its question when idle', async () => {
  const calls = recorder({ turnRunning: () => true })
  const roster = rosterOf()
  roster.models.push({ ref: 'deepseek/pro', provider: 'deepseek', providerName: 'DeepSeek', name: 'Pro' })
  SLOTS = []
  rootProps = { bot: roster.byId.b1, roster, actions: globalThis.ACTIONS, run: promise => promise, saved: true }
  rootTree = draw()
  const steps = () => find(rootTree, node => node.type?.name === 'ModelSteps')
  steps().props.go({ step: 'models', route: 'native' })
  click(steps().type(steps().props), node => node.props.role === 'menuitemradio' && node.props.title === 'deepseek/pro')
  await tick()
  assert.equal(confirmOf(), undefined)
  assert.deepEqual(JSON.parse(JSON.stringify(calls.updated)), [['b1', { model: 'deepseek/pro' }]])
  assert.deepEqual(calls.switched, [])
  // A Bot on Hermes over ACP, idle: the new-conversation question, as before.
  const idle = recorder()
  SLOTS = []
  click(openModels(rosterOf({ id: 'b1', name: 'Ops', model: 'acp-hermes/default', appliedModel: 'acp-hermes/default' })),
    node => node.props.role === 'menuitemradio' && node.props.title === 'acp-claude/haiku')
  const confirm = await confirmNow()
  assert.deepEqual(confirmParts(confirm), { text: 'Changing the agent requires a new conversation if this one has history.', buttons: ['Keep this conversation', 'Change agent'] })
  assert.deepEqual(idle.switched, [])
})

test('C7: a pick the host finds a reply running for opens the running question; Switch resends with stopReply, Cancel sends nothing', async () => {
  for (const answer of ['switch', 'cancel']) {
    const switched = []
    globalThis.ACTIONS = {
      updateBot() { assert.fail('a crossing must use switchRoute') },
      switchRoute: (...args) => {
        switched.push(args)
        return args[3]?.stopReply === true ? Promise.resolve()
          : Promise.reject(Object.assign(new Error('This stops the current reply and continues on Claude Code.'), { code: 'bot/refused', reason: 'reply-running' }))
      },
      refreshModels: () => {},
    }
    pickHaiku()
    await tick()
    await tick()
    const confirm = confirmOf()
    assert.ok(confirm, `${answer}: the host's answer opens the question`)
    assert.deepEqual(confirmParts(confirm), { text: 'This stops the current reply and continues on Claude Code.', buttons: ['Cancel', 'Switch'] })
    assert.equal(switched.length, 1)
    if (answer === 'switch') confirm.props.onConfirm()
    else confirm.props.onCancel()
    await tick()
    assert.deepEqual(JSON.parse(JSON.stringify(switched)), answer === 'switch'
      ? [['b1', 'acp-claude/haiku', {}], ['b1', 'acp-claude/haiku', {}, { stopReply: true }]]
      : [['b1', 'acp-claude/haiku', {}]])
  }
})

test('C9 (menu): while an agent switch runs, a pick sends nothing and the trigger is busy', async () => {
  const calls = recorder({ turnRunning: () => false, modelStateOf: () => ({ switching: { to: 'acp-claude/default', since: 1 } }), subscribeWork: () => () => {} })
  pickHaiku()
  await tick()
  assert.deepEqual(calls.switched, [])
  assert.deepEqual(calls.updated, [])
  assert.equal(find(rootTree, node => node.props.className === 'bt-model-trigger')?.props['aria-busy'], true)
})
