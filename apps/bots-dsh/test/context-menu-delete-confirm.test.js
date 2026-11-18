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

// The menu is a function of its own state: a render reads the state cells in hook order and
// a click writes one, so the next render sees what the first click asked. Effects are not
// run here (no layout, no timers); the ask itself is what these tests read.
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

// A fresh mount, as the app makes one each time the menu opens: its state starts over, so a
// confirmation asked for before the menu closed is gone.
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

// A Bot or a group draws in ContextMenu itself; the DSH bot and Session menus are their own
// component, which ContextMenu returns as an element.
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
  byId: { bot1: { id: 'bot1', name: 'Alpha' } },
  roomsById: { room1: { id: 'room1', name: 'Team', members: ['bot1', 'bot2'] } },
  agentsById: { 'agent-1': { id: 'agent-1', name: 'Original' } },
  mainBotId: 'main', mainBotIds: ['main'],
}

async function settle() { await new Promise(resolve => setTimeout(resolve, 0)) }

test('the sidebar Delete asks before it deletes a Bot', async () => {
  const calls = []
  const { ContextMenu, render } = load()
  const actions = recorded(calls)
  const draw = () => flatten(ContextMenu({ menu: { kind: 'bot', id: 'bot1', x: 10, y: 10 }, roster, actions }))

  let tree = render(draw)
  assert.equal(labelOf(itemOn(tree, 'Delete')), 'Delete')
  itemOn(tree, 'Delete').props.onClick()
  assert.deepEqual(calls, [], 'the first click only asks, it does not delete')

  tree = render(draw)
  assert.equal(labelOf(itemOn(tree, 'Delete')), 'Delete Alpha?')
  itemOn(tree, 'Delete Alpha?').props.onClick()
  await settle()
  assert.deepEqual(calls, ['close', ['deleteBot', 'bot1']])
})

test('the sidebar Delete asks before it deletes a group', async () => {
  const calls = []
  const { ContextMenu, render } = load()
  const actions = recorded(calls)
  const draw = () => flatten(ContextMenu({ menu: { kind: 'room', id: 'room1', x: 10, y: 10 }, roster, actions }))

  let tree = render(draw)
  assert.equal(labelOf(itemOn(tree, 'Delete group')), 'Delete group')
  itemOn(tree, 'Delete group').props.onClick()
  assert.deepEqual(calls, [])

  tree = render(draw)
  assert.equal(labelOf(itemOn(tree, 'Delete Team?')), 'Delete Team?')
  itemOn(tree, 'Delete Team?').props.onClick()
  await settle()
  assert.deepEqual(calls, ['close', ['deleteRoom', 'room1']])
})

test('a menu that closes and reopens asks again instead of remembering the confirmation', async () => {
  const calls = []
  const first = load()
  const actions = recorded(calls)
  const draw = (api) => flatten(api.ContextMenu({ menu: { kind: 'bot', id: 'bot1', x: 10, y: 10 }, roster, actions }))
  first.render(() => draw(first))
  itemOn(first.render(() => draw(first)), 'Delete').props.onClick()
  assert.deepEqual(calls, [])

  // The menu closed (nothing is left asking) and the same one opened again.
  const reopened = load()
  const tree = reopened.render(() => draw(reopened))
  itemOn(tree, 'Delete').props.onClick()
  await settle()
  assert.deepEqual(calls, [], 'the reopened menu asks again rather than deleting')
})

test('the DSH bot menu asks before it removes the bot and archives its Sessions', async () => {
  const calls = []
  const { ContextMenu, render } = load()
  const actions = recorded(calls)
  const draw = () => flatten(ContextMenu({ menu: { kind: 'agent', id: 'agent-1', x: 10, y: 10 }, roster, actions }))

  let tree = render(draw)
  assert.equal(labelOf(itemOn(tree, 'Remove Original')), 'Remove Original')
  itemOn(tree, 'Remove Original').props.onClick()
  assert.deepEqual(calls, [], 'the first click only asks')

  tree = render(draw)
  assert.equal(labelOf(itemOn(tree, 'Remove Original?')), 'Remove Original?')
  itemOn(tree, 'Remove Original?').props.onClick()
  await settle()
  assert.deepEqual(calls, ['close', ['removeAgent', 'agent-1']])
})
