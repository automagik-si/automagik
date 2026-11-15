import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// Other plugins' buttons in the sidebar's top row and rail (extend.js sidebarTools), drawn by
// TeamSidebar with a stand-in React: components run as plain functions. The browser half is
// power-shortcut-browser.test.js.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: "export { TeamSidebar } from './src/client/sidebar.js'\nexport { sidebarTools } from './src/client/extend.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
class Component {
  constructor(props) { this.props = props }
}
const react = {
  Component,
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: initial => [initial, () => {}],
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id',
  // The bundled Deep View widgets make a React context when their module loads.
  createContext: value => ({ Provider: 'Provider', value }), useContext: context => context.value,
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: name => (name === 'react' ? react : {}), window: { innerWidth: 1280 }, console: { warn() {} } })
const { TeamSidebar, sidebarTools } = module.exports

const roster = { bots: [], rooms: [], agents: [], byId: {}, ready: true }
const actions = { openSession: id => id, toggleSidebar() {} }
const sidebar = wide => TeamSidebar({
  wide, actions,
  useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
  useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
})
const nameOf = node => node?.type?.name || node?.props?.['aria-label'] || node?.props?.className
// The top row (wide) or the rail's buttons, in order.
const rowOf = (wide) => {
  const tree = sidebar(wide)
  return [tree.props.children].flat()[0].props.children
}
// What the SidebarTools element draws: one isolated entry per tool.
const drawn = (row) => {
  const outlet = row.find(node => node?.type?.name === 'SidebarTools')
  return { outlet, entries: outlet.type(outlet.props) }
}

test('tools draw between the update cloud and Search, and in the rail under the cloud', () => {
  const Tool = () => null
  const off = sidebarTools.register({ id: 'power', Component: Tool })
  const wideRow = rowOf(true).map(nameOf)
  assert.deepEqual(wideRow.slice(2, 5), ['UpdateButton', 'SidebarTools', 'Search'])
  assert.deepEqual(rowOf(false).map(nameOf), ['UpdateButton', 'SidebarTools', 'New…'])
  const { outlet, entries } = drawn(rowOf(true))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].props.entry.Component, Tool)
  // A tool gets the sidebar's width, roster and actions, and its roster hook.
  assert.deepEqual(Object.keys(outlet.props).filter(key => key !== 'children').sort(), ['actions', 'roster', 'useRoster', 'wide'])
  assert.equal(outlet.props.roster, roster)
  assert.equal(drawn(rowOf(false)).outlet.props.wide, false)
  off()
  assert.equal(drawn(rowOf(true)).entries.length, 0, 'the disposer takes it away')
})

test('a tool registered after the sidebar drew appears, in order', () => {
  assert.equal(drawn(rowOf(true)).entries.length, 0)
  const offLate = sidebarTools.register({ id: 'late', order: 5, Component: () => null })
  const offEarly = sidebarTools.register({ id: 'early', order: -5, Component: () => null })
  assert.equal(drawn(rowOf(true)).entries.map(entry => entry.props.entry.id).join(), 'early,late')
  offLate()
  offEarly()
})

test('a tool that throws draws nothing, and the others still draw', () => {
  const Broken = () => { throw new Error('broken') }
  const Fine = () => 'fine'
  const offBroken = sidebarTools.register({ id: 'broken', Component: Broken })
  const offFine = sidebarTools.register({ id: 'fine', Component: Fine })
  const { entries } = drawn(rowOf(true))
  const Boundary = entries[0].type
  assert.equal(Boundary.getDerivedStateFromError(new Error('broken')).failed, true)
  const broken = new Boundary(entries[0].props)
  broken.state = Boundary.getDerivedStateFromError(new Error('broken'))
  assert.equal(broken.render(), null)
  const fine = new Boundary(entries[1].props)
  assert.equal(fine.render().type, Fine)
  assert.equal(fine.render().props.wide, true)
  offBroken()
  offFine()
})
