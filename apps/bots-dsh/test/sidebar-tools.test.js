import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// Other plugins' buttons in the sidebar's top row (or, behind `?mock-1540`, its bottom row) and
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

// The layout behind the web self-update preview's flag (#1540, #1546): the page is opened with
// `?mock-1540` (or `#mock-1540`) for the new bar, and without it for dev's bar. The flag is read
// at render time, like the mock's, so the tests set the page's location around a render.
const OFF = { search: '', hash: '' }
const ON = { search: '?mock-1540', hash: '' }
const withFlag = (location, run) => {
  sandbox.location = location
  try { return run() } finally { delete sandbox.location }
}

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
// The wide bar's head (left-bar.js: without the flag dev's wordmark and tools, with it Search and
// New… only) or the rail's buttons, in order.
const rowOf = (wide) => {
  const tree = sidebar(wide)
  if (!wide) return [tree.props.children].flat()[0].props.children
  const side = tree.type(tree.props)
  const list = flat(flat(side.props.children)[0].props.children)[1]
  return flat(flat(list.props.children)[0].props.children)
}
// The bar's own bottom row: the Work and Code switch, and behind the flag the other tools too.
const footOf = (wide) => {
  const tree = sidebar(wide)
  const side = tree.type(tree.props)
  const list = flat(flat(side.props.children)[0].props.children)[1]
  const foot = flat(list.props.children).find(node => node?.props?.className === 'lb-foot')
  return flat(foot.props.children)
}
// What the SidebarTools element draws: one isolated entry per tool. The element is in the head
// without the flag and at the foot with it, so both rows are searched.
const drawn = (wide) => {
  const row = [...rowOf(wide), ...(wide ? footOf(wide) : [])]
  const outlet = row.find(node => node?.type?.name === 'SidebarTools')
  return { outlet, entries: outlet.type(outlet.props) }
}

test('without the flag the top row is dev\'s: the cloud, the tools, then Search', () => {
  const Tool = () => null
  const off = sidebarTools.register({ id: 'power', Component: Tool })
  withFlag(OFF, () => {
    const wideRow = rowOf(true).map(nameOf)
    assert.deepEqual(wideRow, ['lb-brand', 'UpdateButton', 'SidebarTools', 'Search', 'New…'], 'dev\'s head, in dev\'s order')
    assert.deepEqual(wideRow.slice(1, 4), ['UpdateButton', 'SidebarTools', 'Search'])
    assert.deepEqual(rowOf(false).map(nameOf), ['UpdateButton', 'SidebarTools', 'New…'])
    const { outlet, entries } = drawn(true)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].props.entry.Component, Tool)
    // A tool gets the sidebar's width, roster and actions, and its roster hook.
    assert.deepEqual(Object.keys(outlet.props).filter(key => key !== 'children').sort(), ['actions', 'roster', 'useRoster', 'wide'])
    assert.equal(outlet.props.roster, roster)
    assert.equal(drawn(false).outlet.props.wide, false)
    off()
    assert.equal(drawn(true).entries.length, 0, 'the disposer takes it away')
  })
})

test('?mock-1540 brings the new bar: Search and New up top, tools at the foot', () => {
  const Tool = () => null
  const off = sidebarTools.register({ id: 'power', Component: Tool })
  withFlag(ON, () => {
    assert.deepEqual(rowOf(true).map(nameOf), ['Search', 'New…'])
    // The tools keep the foot's own entry (the Work and Code switch) after them.
    assert.deepEqual(footOf(true).map(nameOf), ['UpdateButton', 'SidebarTools', 'WorkCodeSwitch'])
    const { outlet, entries } = drawn(true)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].props.entry.Component, Tool)
    assert.equal(outlet.props.wide, true)
    off()
    assert.equal(drawn(true).entries.length, 0, 'the disposer takes it away')
  })
})

test('the flag turns the whole layout on and off in the same page', () => {
  const off = sidebarTools.register({ id: 'power', Component: () => null })
  try {
    withFlag(OFF, () => {
      assert.deepEqual(rowOf(true).map(nameOf).slice(1, 4), ['UpdateButton', 'SidebarTools', 'Search'])
      assert.equal(footOf(true).some(node => node?.type?.name === 'SidebarTools'), false)
    })
    withFlag(ON, () => {
      assert.deepEqual(rowOf(true).map(nameOf), ['Search', 'New…'])
      assert.equal(footOf(true).some(node => node?.type?.name === 'SidebarTools'), true)
    })
    withFlag(OFF, () => {
      assert.deepEqual(rowOf(true).map(nameOf).slice(1, 4), ['UpdateButton', 'SidebarTools', 'Search'])
    })
    // The same predicate #1546 reads: a whole query value, its `=`, or the hash, never a prefix.
    withFlag({ search: '?mock-1540=1', hash: '' }, () => assert.deepEqual(rowOf(true).map(nameOf), ['Search', 'New…']))
    withFlag({ search: '', hash: '#mock-1540' }, () => assert.deepEqual(rowOf(true).map(nameOf), ['Search', 'New…']))
    for (const location of [
      { search: '?mock-1540-other=1', hash: '' },
      { search: '?other=1', hash: '' },
      { search: '?not-mock-1540=1', hash: '' },
      { search: '', hash: '' },
    ]) {
      withFlag(location, () => {
        assert.deepEqual(rowOf(true).map(nameOf).slice(1, 4), ['UpdateButton', 'SidebarTools', 'Search'], JSON.stringify(location))
      })
    }
  } finally { off() }
})

test('a tool registered after the sidebar drew appears, in order, in either layout', () => {
  for (const location of [OFF, ON]) {
    withFlag(location, () => {
      assert.equal(drawn(true).entries.length, 0)
      const offLate = sidebarTools.register({ id: 'late', order: 5, Component: () => null })
      const offEarly = sidebarTools.register({ id: 'early', order: -5, Component: () => null })
      try {
        assert.equal(drawn(true).entries.map(entry => entry.props.entry.id).join(), 'early,late')
      } finally { offLate(); offEarly() }
    })
  }
})

test('a tool that throws draws nothing, and the others still draw', () => {
  for (const location of [OFF, ON]) {
    withFlag(location, () => {
      const Broken = () => { throw new Error('broken') }
      const Fine = () => 'fine'
      const offBroken = sidebarTools.register({ id: 'broken', Component: Broken })
      const offFine = sidebarTools.register({ id: 'fine', Component: Fine })
      try {
        const { entries } = drawn(true)
        const Boundary = entries[0].type
        assert.equal(Boundary.getDerivedStateFromError(new Error('broken')).failed, true)
        const broken = new Boundary(entries[0].props)
        broken.state = Boundary.getDerivedStateFromError(new Error('broken'))
        assert.equal(broken.render(), null)
        const fine = new Boundary(entries[1].props)
        assert.equal(fine.render().type, Fine)
        assert.equal(fine.render().props.wide, true)
      } finally { offBroken(); offFine() }
    })
  }
})
