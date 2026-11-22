import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// Other plugins' buttons in the wide sidebar's bottom row and
// the rail (extend.js sidebarTools), drawn by TeamSidebar with a stand-in React: components run
// as plain functions. The marketplace's Apps button is one of these entries.
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
const sandbox = {
  module, exports: module.exports, require: name => (name === 'react' ? react : {}),
  window: { innerWidth: 1280 }, console: { warn() {} },
}
runInNewContext(outputFiles[0].text, sandbox)
const { TeamSidebar, sidebarTools } = module.exports

const roster = { bots: [], rooms: [], agents: [], byId: {}, ready: true }
const actions = { openSession: id => id, toggleSidebar() {} }
const sidebar = wide => TeamSidebar({
  wide, actions,
  useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
  useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
  useSessionStatus: pick => pick(new Map()), useActivity: pick => pick({}),
})
// Fragments drawn in place, so a row reads as the buttons it shows.
const flat = nodes => [nodes].flat(Infinity).flatMap(node => (node?.type === react.Fragment ? flat(node.props.children) : [node])).filter(Boolean)
const nameOf = node => node?.type?.name || node?.props?.['aria-label'] || node?.props?.className
// The wide head or the rail's buttons, in order.
const rowOf = (wide) => {
  const tree = sidebar(wide)
  if (!wide) return [tree.props.children].flat()[0].props.children
  const side = tree.type(tree.props)
  const list = flat(flat(side.props.children)[0].props.children)[1]
  return flat(flat(list.props.children)[0].props.children)
}
// The wide footer contains the existing tools (RFC 0022 Q9: the Work and Code switch left the bar).
const footOf = (wide) => {
  const tree = sidebar(wide)
  const side = tree.type(tree.props)
  const list = flat(flat(side.props.children)[0].props.children)[1]
  const foot = flat(list.props.children).find(node => node?.props?.className === 'lb-foot')
  return flat(foot.props.children)
}
// What the SidebarTools outlet draws: one isolated entry per tool.
const drawn = (wide) => {
  const row = [...rowOf(wide), ...(wide ? footOf(wide) : [])]
  const outlet = row.find(node => node?.type?.name === 'SidebarTools')
  return { outlet, entries: outlet.type(outlet.props) }
}

test('wide and narrow layouts keep the cloud, tools and sidebar controls, with no Work and Code switch', () => {
  const Tool = () => null
  const off = sidebarTools.register({ id: 'power', Component: Tool })
  try {
    assert.deepEqual(rowOf(true).map(nameOf), ['Search', 'New…'])
    assert.deepEqual(footOf(true).map(nameOf), ['UpdateButton', 'SidebarTools'])
    assert.deepEqual(rowOf(false).map(nameOf), ['UpdateButton', 'SidebarTools', 'New…'])
    const { outlet, entries } = drawn(true)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].props.entry.Component, Tool)
    assert.deepEqual(Object.keys(outlet.props).filter(key => key !== 'children').sort(), ['actions', 'roster', 'useRoster', 'wide'])
    assert.equal(outlet.props.roster, roster)
    assert.equal(outlet.props.wide, true)
    assert.equal(drawn(false).outlet.props.wide, false)
    const wide = sidebar(true)
    assert.equal(wide.props.collapse.props['aria-label'], 'Collapse sidebar')
  } finally { off() }
  assert.equal(drawn(true).entries.length, 0, 'the disposer takes the tool away')
})

test('a tool registered after the sidebar drew appears in order in both widths', () => {
  assert.equal(drawn(true).entries.length, 0)
  const offLate = sidebarTools.register({ id: 'late', order: 5, Component: () => null })
  const offEarly = sidebarTools.register({ id: 'early', order: -5, Component: () => null })
  try {
    for (const wide of [true, false]) assert.equal(drawn(wide).entries.map(entry => entry.props.entry.id).join(), 'early,late')
  } finally { offLate(); offEarly() }
})

test('a tool that throws draws nothing, and the others still draw', () => {
  const Broken = () => { throw new Error('broken') }
  const Fine = () => 'fine'
  const offBroken = sidebarTools.register({ id: 'broken', Component: Broken })
  const offFine = sidebarTools.register({ id: 'fine', Component: Fine })
  try {
    for (const wide of [true, false]) {
      const { entries } = drawn(wide)
      const Boundary = entries[0].type
      const broken = new Boundary(entries[0].props)
      broken.state = Boundary.getDerivedStateFromError(new Error('broken'))
      assert.equal(broken.state.failed, true)
      assert.equal(broken.render(), null)
      const fine = new Boundary(entries[1].props)
      assert.equal(fine.render().type, Fine)
      assert.equal(fine.render().props.wide, wide)
    }
  } finally { offBroken(); offFine() }
})
