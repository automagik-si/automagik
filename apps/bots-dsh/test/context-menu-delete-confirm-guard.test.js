import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/context-menu.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

// A menu render reads the state cells in hook order and a click writes one, so the next render
// sees what the click did. Effects are not run here (no layout, no timers); the confirmation
// state and its guards are what these tests read.
function hooks() {
  const states = []
  let cursor = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    Fragment: 'Fragment',
    useState(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = initial
      return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
    },
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: make => make(),
    useRef: current => ({ current }),
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  }
  const render = (make) => { cursor = 0; return make() }
  return { react, render }
}

function load() {
  const lifecycle = hooks()
  const module = { exports: {} }
  runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports,
    document: { body: {}, activeElement: null },
    window: { innerWidth: 1280, innerHeight: 800, visualViewport: null, addEventListener() {}, removeEventListener() {} },
    navigator: { clipboard: { writeText() {} } },
    setTimeout, clearTimeout,
    require: name => {
      const platform = {
        react: lifecycle.react,
        'react-dom': { createPortal: node => node },
        '@deepseek-ai/dsh-client-ui-primitives': {},
      }
      if (!(name in platform)) throw new Error(`no platform module ${name}`)
      return platform[name]
    },
  })
  return { ContextMenu: module.exports.ContextMenu, render: lifecycle.render }
}

function walk(tree, found = []) {
  if (!tree || typeof tree !== 'object') return found
  found.push(tree)
  for (const child of tree.children ?? []) walk(child, found)
  return found
}

function labelOf(item) {
  const span = item.children.find(child => child?.props?.className === 'bt-menu-label')
  return (span ?? item).children.filter(child => typeof child === 'string').at(-1)
}

const itemsOf = tree => walk(tree).filter(node => node.props?.role === 'menuitem')
const itemOn = (tree, prefix) => itemsOf(tree).find(node => String(labelOf(node)).startsWith(prefix))

const flatten = node => (typeof node?.type === 'function' ? flatten(node.type(node.props)) : node)

const noop = () => {}
const recorded = (calls) => ({
  closeMenu: () => calls.push('close'),
  deleteBot: id => { calls.push(['deleteBot', id]); return Promise.resolve() },
  deleteRoom: id => { calls.push(['deleteRoom', id]); return Promise.resolve() },
  removeAgent: id => { calls.push(['removeAgent', id]); return Promise.resolve() },
  reportError: noop,
})

const roster = {
  byId: {
    bot1: { id: 'bot1', name: 'Alpha' },
    bot2: { id: 'bot2', name: 'Beta' },
  },
  roomsById: { room1: { id: 'room1', name: 'Team', members: ['bot1', 'bot2'] } },
  agentsById: {
    'agent-1': { id: 'agent-1', name: 'Original' },
    'agent-2': { id: 'agent-2', name: 'Second' },
  },
  mainBotId: 'main', mainBotIds: ['main'],
}

async function settle() { await new Promise(resolve => setTimeout(resolve, 0)) }

// A draw reads the same state cells on every call: an instance that stays mounted, as the
// menu does during its exit linger.
const botDraw = (ContextMenu, actions, id = 'bot1', leaving = false) =>
  () => flatten(ContextMenu({ menu: { kind: 'bot', id, x: 10, y: 10 }, roster, actions, leaving }))
const agentDraw = (ContextMenu, actions, id = 'agent-1', leaving = false) =>
  () => flatten(ContextMenu({ menu: { kind: 'agent', id, x: 10, y: 10 }, roster, actions, leaving }))

// The confirmation must not replace the item: React keys by identity, and a new key unmounts
// the focused button, dropping focus to the body (and the screen reader's place with it).
test('the confirmation keeps the Delete item identity, so focus and the screen reader stay put', () => {
  const { ContextMenu, render } = load()
  const draw = botDraw(ContextMenu, recorded([]))

  const before = itemOn(render(draw), 'Delete')
  assert.equal(labelOf(before), 'Delete')
  before.props.onClick()

  const after = itemOn(render(draw), 'Delete Alpha?')
  assert.ok(after)
  assert.equal(after.props.key, before.props.key, 'the confirming item keeps the same React key')
})

test('the confirmation keeps the Remove item identity in the DSH menu too', () => {
  const { ContextMenu, render } = load()
  const draw = agentDraw(ContextMenu, recorded([]))

  const before = itemOn(render(draw), 'Remove Original')
  assert.equal(labelOf(before), 'Remove Original')
  before.props.onClick()

  const after = itemOn(render(draw), 'Remove Original?')
  assert.ok(after)
  assert.equal(after.props.key, before.props.key, 'the confirming item keeps the same React key')
})

// A pointer double click or a second Enter sends onClick twice; only the first may act.
test('a second click on the confirming Delete deletes once', async () => {
  const calls = []
  const { ContextMenu, render } = load()
  const draw = botDraw(ContextMenu, recorded(calls))

  itemOn(render(draw), 'Delete').props.onClick()
  assert.deepEqual(calls, [], 'the first click only asks')

  itemOn(render(draw), 'Delete Alpha?').props.onClick()
  await settle()
  assert.deepEqual(calls, ['close', ['deleteBot', 'bot1']])

  // The menu lingers while it leaves; the double click's second event still reaches it.
  itemOn(render(draw), 'Delete Alpha?').props.onClick()
  await settle()
  assert.deepEqual(calls, ['close', ['deleteBot', 'bot1']], 'the second confirming click is inert')

  itemOn(render(draw), 'Delete Alpha?').props.onClick()
  await settle()
  assert.deepEqual(calls, ['close', ['deleteBot', 'bot1']], 'the third confirming click is inert too')
})

test('a second click on the confirming Remove removes once', async () => {
  const calls = []
  const { ContextMenu, render } = load()
  const draw = agentDraw(ContextMenu, recorded(calls))

  itemOn(render(draw), 'Remove Original').props.onClick()
  assert.deepEqual(calls, [], 'the first click only asks')

  itemOn(render(draw), 'Remove Original?').props.onClick()
  await settle()
  assert.deepEqual(calls, ['close', ['removeAgent', 'agent-1']])

  itemOn(render(draw), 'Remove Original?').props.onClick()
  await settle()
  assert.deepEqual(calls, ['close', ['removeAgent', 'agent-1']], 'the second confirming click is inert')
})

// The exit linger keeps the mounted menu for 120ms; a click that lands there must not delete.
test('a click on the confirming Delete while the menu leaves is inert', async () => {
  const calls = []
  const { ContextMenu, render } = load()

  itemOn(render(botDraw(ContextMenu, recorded(calls))), 'Delete').props.onClick()
  assert.deepEqual(calls, [], 'the first click only asks')

  itemOn(render(botDraw(ContextMenu, recorded(calls), 'bot1', true)), 'Delete').props.onClick()
  await settle()
  assert.deepEqual(calls, [], 'a click during the exit does not delete')
})

// A confirmation belongs to one menu item: moving to another Bot must ask for that Bot.
test('a confirmation does not carry over when the menu target changes', async () => {
  const calls = []
  const { ContextMenu, render } = load()

  itemOn(render(botDraw(ContextMenu, recorded(calls), 'bot1')), 'Delete').props.onClick()
  assert.deepEqual(calls, [], 'the first click only asks')

  const item = itemOn(render(botDraw(ContextMenu, recorded(calls), 'bot2')), 'Delete')
  assert.equal(labelOf(item), 'Delete', 'the other Bot is not shown the confirmation')
  item.props.onClick()
  await settle()
  assert.deepEqual(calls, [], 'the other Bot was asked instead of deleted')
})

// Closing and reopening the same item at the same place inside the exit linger reuses the
// mount; the reopened menu must ask again.
test('a confirmation does not survive the menu leaving and reopening in the same mount', async () => {
  const calls = []
  const { ContextMenu, render } = load()

  itemOn(render(botDraw(ContextMenu, recorded(calls), 'bot1', false)), 'Delete').props.onClick()
  assert.deepEqual(calls, [], 'the first click only asks')

  render(botDraw(ContextMenu, recorded(calls), 'bot1', true))
  const item = itemOn(render(botDraw(ContextMenu, recorded(calls), 'bot1', false)), 'Delete')
  assert.equal(labelOf(item), 'Delete', 'the reopened menu starts without a confirmation')
  item.props.onClick()
  await settle()
  assert.deepEqual(calls, [], 'the reopened menu asks again instead of deleting')
})
