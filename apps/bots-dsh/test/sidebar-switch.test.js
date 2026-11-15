import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

// The sidebar and its style sheets import the browser's React; bundle them with a minimal
// stand-in, as the tool-cell tests do: components run as plain functions. Navigation
// fixtures retain refs across commits and run their layout effects after each render.
const { outputFiles } = await build({
  stdin: {
    contents: "export { SHELL_CSS } from './src/client/styles.js'\nexport { SIDEBAR_CSS, TeamSidebar } from './src/client/sidebar.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let renderRefs
let refIndex = 0
let layoutEffects
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect: effect => layoutEffects?.push(effect), useState: initial => [initial, () => {}],
  useMemo: make => make(), useRef: current => renderRefs ? renderRefs[refIndex++] ??= { current } : { current }, useId: () => 'id',
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
}
const module = { exports: {} }
const viewport = { innerWidth: 1280 }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : {}),
  window: viewport,
})
const { SHELL_CSS, SIDEBAR_CSS, TeamSidebar } = module.exports

function navigationSidebar(wide, { shell = true } = {}) {
  const calls = []
  const refs = []
  let collapsed = !wide
  const bot = { id: 'writer', name: 'Writer', createdAt: 1 }
  const room = { id: 'room', name: 'Team', members: [], createdAt: 2 }
  const agent = { id: 'agent', sessions: ['session'], createdAt: 3 }
  const roster = { bots: [bot], rooms: [room], agents: [agent], byId: { writer: bot }, ready: true }
  const actions = Object.fromEntries(['openSession', 'openAgent', 'openAgentSession', 'newAgentSession'].map(name => [name, id => { calls.push([name, id]); return id }]))
  actions.toggleSidebar = () => { collapsed = !collapsed; calls.push(['toggleSidebar']) }
  const rows = []
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node || typeof node !== 'object') return
    if (['BotRow', 'RoomRow', 'AgentRow'].includes(node.type?.name)) rows.push(node)
    walk(node.props?.children)
  }
  const render = (nextWide = shell ? wide : !collapsed) => {
    wide = nextWide
    // The public owner action closes over the shell's committed collapsed state;
    // wide may still be true during the shell's 150ms content fade-out.
    const committedCollapsed = collapsed
    renderRefs = refs
    refIndex = 0
    layoutEffects = []
    const tree = TeamSidebar({
      wide, actions,
      ...(shell ? { expandSidebar: () => { if (committedCollapsed) actions.toggleSidebar() } } : {}),
      useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
      useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
    })
    renderRefs = undefined
    const effects = layoutEffects
    layoutEffects = undefined
    effects.forEach(effect => effect())
    rows.length = 0
    walk(tree)
  }
  render()
  return { calls, rows, actions, render, get collapsed() { return collapsed } }
}

for (const width of [390, 1023, 1024, 1280]) {
  for (const wide of [false, true]) {
    test(`sidebar navigation at ${width}px with ${wide ? 'expanded content' : 'a collapsed rail'} only closes an open mobile sidebar`, () => {
      viewport.innerWidth = width
      const initial = navigationSidebar(wide)
      assert.equal(initial.rows.length, 3)
      for (const [index, row] of initial.rows.entries()) {
        const names = row.type.name === 'AgentRow' ? ['openAgent', 'openAgentSession', 'newAgentSession'] : ['openSession']
        for (const name of names) {
          const { rows, calls } = navigationSidebar(wide)
          assert.equal(rows[index].props.actions[name]('selected'), 'selected')
          assert.deepEqual(calls, wide && width < 1024 ? [[name, 'selected'], ['toggleSidebar']] : [[name, 'selected']])
        }
      }
    })
  }
}

test('repeated sidebar navigation before another commit closes only once', () => {
  viewport.innerWidth = 390
  const side = navigationSidebar(true)
  side.rows[0].props.actions.openAgent('first')
  side.rows[1].props.actions.openSession('second')
  assert.equal(side.collapsed, true)
  assert.deepEqual(side.calls, [['openAgent', 'first'], ['toggleSidebar'], ['openSession', 'second']])
})

test('the standalone UI can navigate without a shell expansion action', () => {
  viewport.innerWidth = 390
  // app/ui passes its actual wide state directly, without the DSH owner action.
  const side = navigationSidebar(true, { shell: false })
  side.rows[1].props.actions.openSession('first')
  side.rows[2].props.actions.openSession('second')
  assert.equal(side.collapsed, true)
  assert.deepEqual(side.calls, [['openSession', 'first'], ['toggleSidebar'], ['openSession', 'second']])
  side.render()
  side.calls.length = 0
  side.rows[1].props.actions.openSession('from-rail')
  assert.deepEqual(side.calls, [['openSession', 'from-rail']])
  side.actions.toggleSidebar()
  side.render()
  side.rows[2].props.actions.openSession('after-expansion')
  assert.equal(side.collapsed, true)
})

test('navigation during the shell fade-out keeps the already collapsed sidebar closed', () => {
  viewport.innerWidth = 390
  const side = navigationSidebar(true)
  side.rows[0].props.actions.openAgentSession('first')
  assert.equal(side.collapsed, true)
  side.render(true)
  side.calls.length = 0
  side.rows[1].props.actions.openSession('during-fade')
  assert.equal(side.collapsed, true, 'wide remains true until the content fade settles')
  assert.equal(side.calls.filter(([name]) => name === 'openSession').length, 1)
})

test('a sidebar reopened before wide becomes false still closes on the next navigation', () => {
  viewport.innerWidth = 390
  const side = navigationSidebar(true)
  side.rows[0].props.actions.openAgent('first')
  side.render(true)
  side.actions.toggleSidebar()
  side.render(true)
  assert.equal(side.collapsed, false)
  side.rows[1].props.actions.openSession('after-reopen')
  assert.equal(side.collapsed, true)
})

test('the navigation guard resets across a full collapse and expansion cycle', () => {
  viewport.innerWidth = 390
  const side = navigationSidebar(true)
  side.rows[0].props.actions.newAgentSession('first')
  side.render(false)
  side.calls.length = 0
  side.rows[1].props.actions.openSession('from-rail')
  assert.equal(side.collapsed, true)
  assert.deepEqual(side.calls, [['openSession', 'from-rail']])
  side.actions.toggleSidebar()
  side.render(true)
  side.rows[1].props.actions.openSession('after-expansion')
  assert.equal(side.collapsed, true)
})

// A Bot working in its own chat previews what it is doing, the way a group row does
// for members at work; an idle Bot keeps the last message preview.
test('a running Bot\'s sidebar row shows what it is doing', () => {
  viewport.innerWidth = 1280
  const bot = { id: 'writer', name: 'Writer', createdAt: 1 }
  const roster = { bots: [bot], rooms: [], agents: [], byId: { writer: bot }, ready: true, exchangeTurns: {} }
  const rows = []
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node || typeof node !== 'object') return
    if (node.type?.name === 'BotRow') rows.push(node)
    walk(node.props?.children)
  }
  const tree = TeamSidebar({
    wide: true,
    actions: Object.fromEntries(['openSession', 'openAgent', 'openAgentSession', 'newAgentSession', 'openMenu', 'openPalette', 'openNewChat', 'toggleSidebar', 'clearUnread'].map(name => [name, () => {}])),
    useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
    useSessionStatus: pick => pick(new Map([['writer', { running: true }]])),
    useSessionRetainInfo: () => null,
    useActivity: pick => pick({ writer: 'working' }),
    useWork: pick => pick({ waiting: {}, rooms: {}, approvals: [] }),
  })
  walk(tree)
  assert.equal(rows.length, 1)
  // BotRow renders as a function component: run it, then flatten Shimmer and the
  // other function children to read the preview line's text.
  const expand = (node) => {
    if (Array.isArray(node)) return node.map(expand)
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') return expand(node.type(node.props))
    return { ...node, props: { ...node.props, children: expand(node.props.children) } }
  }
  const previews = []
  const collect = (node) => {
    if (Array.isArray(node)) { node.forEach(collect); return }
    if (!node || typeof node !== 'object') return
    if (node.props?.className === 'bt-row-preview') previews.push(node)
    collect(node.props?.children)
  }
  const textOf = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join('')
    return textOf(node.props?.children)
  }
  collect(expand(rows[0].type(rows[0].props)))
  assert.equal(previews.length, 1)
  // The row already says Writer, so the preview is the doing phrase alone.
  assert.match(textOf(previews[0]), /^.+…$/)
  assert.doesNotMatch(textOf(previews[0]), /^Writer ·/)
})

test('an idle Bot\'s sidebar row keeps the message preview', () => {
  viewport.innerWidth = 1280
  const bot = { id: 'writer', name: 'Writer', createdAt: 1 }
  const roster = { bots: [bot], rooms: [], agents: [], byId: { writer: bot }, ready: true, exchangeTurns: {} }
  const rows = []
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node || typeof node !== 'object') return
    if (node.type?.name === 'BotRow') rows.push(node)
    walk(node.props?.children)
  }
  const tree = TeamSidebar({
    wide: true,
    actions: Object.fromEntries(['openSession', 'openAgent', 'openAgentSession', 'newAgentSession', 'openMenu', 'openPalette', 'openNewChat', 'toggleSidebar', 'clearUnread'].map(name => [name, () => {}])),
    useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
    useSessionStatus: pick => pick(new Map()),
    useSessionRetainInfo: () => null,
    useActivity: pick => pick({}),
    useWork: pick => pick({ waiting: {}, rooms: {}, approvals: [] }),
  })
  walk(tree)
  const expand = (node) => {
    if (Array.isArray(node)) return node.map(expand)
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') return expand(node.type(node.props))
    return { ...node, props: { ...node.props, children: expand(node.props.children) } }
  }
  const previews = []
  const collect = (node) => {
    if (Array.isArray(node)) { node.forEach(collect); return }
    if (!node || typeof node !== 'object') return
    if (node.props?.className === 'bt-row-preview') previews.push(node)
    collect(node.props?.children)
  }
  collect(expand(rows[0].type(rows[0].props)))
  assert.equal(previews.length, 0)
})

test('preparing sidebar navigation leaves actions elsewhere unchanged', () => {
  viewport.innerWidth = 390
  const { actions, calls } = navigationSidebar(true)
  assert.deepEqual(calls, [])
  actions.openSession('from-another-surface')
  assert.deepEqual(calls, [['openSession', 'from-another-surface']])
})

function rulesOf(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = []
  for (let at = 0; ;) {
    const open = text.indexOf('{', at)
    if (open === -1) return rules
    let end = open + 1
    for (let depth = 1; depth > 0; end += 1) depth += text[end] === '{' ? 1 : text[end] === '}' ? -1 : 0
    const selector = text.slice(at, open).trim()
    if (!selector.startsWith('@')) rules.push({ selector, body: text.slice(open + 1, end - 1).replace(/\s+/g, '') })
    at = end
  }
}
// The narrow bar shows avatars only, and a group's name can be 60 characters long: a row
// whose name is not on screen in full shows it on hover.
test('a sidebar row shows its name on hover when the name is hidden or cut', () => {
  viewport.innerWidth = 1280
  const bot = { id: 'writer', name: 'Writer', createdAt: 1 }
  const room = { id: 'room', name: 'Launch plan for the spring release', members: ['writer'], createdAt: 2 }
  const roster = { bots: [bot], rooms: [room], agents: [], byId: { writer: bot }, roomsById: { room }, ready: true, exchangeTurns: {} }
  const rowsOf = (wide) => {
    const rows = []
    const walk = (node) => {
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (!node || typeof node !== 'object') return
      if (['BotRow', 'RoomRow'].includes(node.type?.name)) rows.push(node)
      walk(node.props?.children)
    }
    walk(TeamSidebar({
      wide,
      actions: Object.fromEntries(['openSession', 'openMenu', 'openPalette', 'openNewChat', 'toggleSidebar', 'clearUnread'].map(name => [name, () => {}])),
      useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
      useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
      useSessionStatus: pick => pick(new Map()), useSessionRetainInfo: () => null,
      useActivity: pick => pick({}), useWork: pick => pick({ waiting: {}, rooms: {}, approvals: [] }),
    }))
    return Object.fromEntries(rows.map(row => [row.type.name, row.type(row.props)]))
  }
  const narrow = rowsOf(false)
  assert.equal(narrow.BotRow.props.title, 'Writer')
  assert.equal(narrow.RoomRow.props.title, 'Launch plan for the spring release')
  const wide = rowsOf(true)
  assert.equal(wide.RoomRow.props.title, undefined)
  // jsdom lays nothing out, so the name's widths are set by hand.
  const { document } = new JSDOM('<button title="stale"><span class="bt-row-title">Launch plan for the spring release</span></button>').window
  const button = document.querySelector('button')
  const name = button.firstChild
  Object.defineProperty(name, 'clientWidth', { value: 120 })
  Object.defineProperty(name, 'scrollWidth', { value: 120, configurable: true })
  wide.RoomRow.props.onMouseEnter({ currentTarget: button })
  assert.equal(button.hasAttribute('title'), false)
  Object.defineProperty(name, 'scrollWidth', { value: 260 })
  wide.RoomRow.props.onMouseEnter({ currentTarget: button })
  assert.equal(button.title, 'Launch plan for the spring release')
  assert.equal(wide.BotRow.props.onMouseEnter, wide.RoomRow.props.onMouseEnter)
})

const SHELL_PARTS = /_logoRow|_brand|_toggle|_newSession|_footArea|_collapsed|_topStrip|bt-side-collapse/
const rules = [...rulesOf(SHELL_CSS), ...rulesOf(SIDEBAR_CSS)].filter(rule => SHELL_PARTS.test(rule.selector))
const hiding = rules.filter(rule => /display:none/.test(rule.body))

// dsh-client-ui-sidebar's own rules for the toggle's two icons (class names match on their
// stems here, as above). In a collapsed rail the rail mark shows, while the native panel
// icon is hidden at rest and revealed on hover, or under a Windows title bar. The team
// view's rules come after these, as its stylesheet loads later.
const SHELL_ICON_RULES = [
  { selector: '[class*="_railMark"]', body: 'display:inline-flex' },
  { selector: '[class*="_collapsed"] [class*="_toggle"] [class*="_panelIcon"]', body: 'display:none' },
  { selector: '[data-windows-titlebar] [class*="_collapsed"] [class*="_toggle"] [class*="_panelIcon"]', body: 'display:inline' },
  { selector: '[class*="_collapsed"] [class*="_toggle"]:hover [class*="_panelIcon"]', body: 'display:inline' },
  { selector: '[class*="_collapsed"] [class*="_toggle"]:hover [class*="_railMark"]', body: 'display:none' },
]

// The display the cascade gives a toggle icon, with the toggle hovered or at rest. An
// !important declaration beats every normal one; otherwise the last matching rule wins.
function iconDisplay(node, hover) {
  let display
  let important = false
  for (const rule of [...SHELL_ICON_RULES, ...rules]) {
    const onHover = rule.selector.includes(':hover')
    if (onHover && !hover) continue
    if (!node.matches(onHover ? rule.selector.replace(/:hover/g, '') : rule.selector)) continue
    const declaration = rule.body.match(/(?:^|;)display:([^;!]+)(!important)?/)
    if (!declaration) continue
    if (declaration[2]) { display = declaration[1]; important = true }
    else if (!important) display = declaration[1]
  }
  return display ?? 'inline'
}

// The shell sidebar's own markup (dsh-client-ui-sidebar SidebarRoot), reduced to what the
// team view reshapes: the switch is in the logo row, except in a macOS desktop window,
// where it sits in the strip by the window buttons.
function shell({ platform, collapsed }) {
  const darwin = platform === 'mac'
  const windows = platform === 'windows'
  // dsh-client-ui-sidebar's toggle: only a collapsed rail outside a Windows title bar
  // carries the rail mark, and every toggle carries the native panel icon.
  const railMark = collapsed && !windows ? '<span class="x_railMark" aria-hidden="true"><svg></svg></span>' : ''
  const toggle = `<button class="x_iconButton x_toggle" data-sidebar-toggle aria-label="Toggle sidebar">${railMark}<svg class="x_panelIcon" aria-hidden="true"></svg></button>`
  const html = `<!doctype html><html${platform === 'windows' ? ' data-windows-titlebar' : ''}${darwin ? ' data-platform="darwin"' : ''}><body>
    <div${collapsed ? ' data-sidebar-collapsed="true"' : ''}>
      <div class="x_root${collapsed ? ' x_collapsed' : ''}">
        ${darwin ? `<div class="x_topStrip">${toggle}</div>` : ''}
        <div class="x_logoRow">${collapsed ? '' : '<button class="x_brand x_wide"></button>'}${darwin ? '' : toggle}</div>
        <div class="x_newSession"></div>
        <div class="team">${collapsed ? '' : '<div class="bt-side-top"><button class="bt-round bt-side-collapse"></button></div>'}</div>
        <div class="x_footArea"><span class="bt-foot-account"></span></div>
      </div>
    </div></body></html>`
  const { document } = new JSDOM(html).window
  const hidden = (node) => {
    for (let at = node; at && at.nodeType === 1; at = at.parentElement) {
      if (hiding.some(rule => at.matches(rule.selector))) return true
    }
    return false
  }
  const switches = [...document.querySelectorAll('.x_toggle, .bt-side-collapse')].filter(node => !hidden(node))
  return { document, hidden, switches }
}

for (const platform of ['web', 'windows', 'mac']) {
  for (const collapsed of [false, true]) {
    test(`${collapsed ? 'a collapsed' : 'an open'} sidebar on ${platform} shows exactly one sidebar switch`, () => {
      const { document, hidden, switches } = shell({ platform, collapsed })
      assert.equal(switches.length, 1, `switches shown: ${switches.map(node => node.className).join(' | ') || 'none'}`)
      const [shown] = switches
      // An open sidebar on the web has the team's own button; everywhere else the shell's
      // switch stays where the shell puts it.
      assert.equal(shown.classList.contains('bt-side-collapse'), platform === 'web' && !collapsed)
      // What the team view replaces stays out of sight.
      assert.equal(hidden(document.querySelector('.x_newSession')), true)
      const brand = document.querySelector('.x_brand')
      if (brand) assert.equal(hidden(brand), true)
    })
  }
}

// DSH reveals its native toggle icon on hover; the team view must keep exactly that one
// icon there, at rest and on hover, never a second glyph of its own.
for (const platform of ['web', 'windows', 'mac']) {
  for (const collapsed of [false, true]) {
    test(`${collapsed ? 'a collapsed' : 'an open'} sidebar on ${platform} shows exactly one toggle icon at rest and on hover`, () => {
      const { document, hidden } = shell({ platform, collapsed })
      const icons = [...document.querySelectorAll('[class*="_panelIcon"], [class*="_railMark"]')]
      const railMark = document.querySelector('[class*="_railMark"]')
      for (const hover of [false, true]) {
        const state = `${platform}, ${collapsed ? 'collapsed' : 'open'}, ${hover ? 'hover' : 'rest'}`
        const shown = icons.filter(node => iconDisplay(node, hover) !== 'none')
        assert.equal(shown.length, 1, `${state}: shown ${shown.map(node => node.getAttribute('class')).join(' | ') || 'none'}`)
        assert.equal(shown[0].matches('[class*="_panelIcon"]'), true, `${state}: ${shown[0].getAttribute('class')}`)
        if (railMark) {
          assert.equal(hidden(railMark), true, `${state}: rail mark hidden by the team view`)
          assert.equal(iconDisplay(railMark, hover), 'none', `${state}: rail mark`)
        }
      }
    })
  }
}

// The closed rail painted its own glyph in front of the shell's toggle. DSH shows its
// native icon on hover, so the pseudo-element left two icons on screen.
test('the sidebar styles add no pseudo-icon to the shell\'s toggle', () => {
  const pseudo = [...rulesOf(SHELL_CSS), ...rulesOf(SIDEBAR_CSS)].filter(rule => /_toggle[^,]*::before/.test(rule.selector))
  assert.deepEqual(pseudo.map(rule => rule.selector), [])
})

test('an open sidebar has a button that collapses it; the rail leaves that to the shell', () => {
  const calls = []
  const roster = { bots: [], rooms: [], agents: [], byId: {}, ready: true }
  const props = wide => ({
    wide,
    useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
    actions: { toggleSidebar: () => calls.push('toggle') },
  })
  const find = (node, match) => {
    if (Array.isArray(node)) return node.map(child => find(child, match)).find(Boolean)
    if (!node || typeof node !== 'object') return undefined
    return match(node) ? node : find(node.props?.children, match)
  }
  const collapse = node => node.type === 'button' && node.props['aria-label'] === 'Collapse sidebar'
  const button = find(TeamSidebar(props(true)), collapse)
  assert.ok(button?.props.className.split(' ').includes('bt-side-collapse'))
  button.props.onClick()
  assert.deepEqual(calls, ['toggle'])
  assert.equal(find(TeamSidebar(props(false)), collapse), undefined)
})

test('the logo row takes no room in an open sidebar under a Windows title bar', () => {
  const { document } = shell({ platform: 'windows', collapsed: false })
  const row = document.querySelector('.x_logoRow')
  const flat = rules.filter(rule => row.matches(rule.selector) && /height:0!important/.test(rule.body))
  assert.equal(flat.length, 1)
  assert.equal(shell({ platform: 'windows', collapsed: true }).document.querySelector('.x_logoRow').matches(flat[0].selector), false)
})

// The shell hides the footer of a collapsed sidebar under a Windows title bar, whose width
// is zero; a forced display put the account button off the screen.
test('the team view lays out the shell footer but never decides whether it shows', () => {
  const { document } = shell({ platform: 'windows', collapsed: true })
  const foot = document.querySelector('.x_footArea')
  const deciding = rules.filter(rule => foot.matches(rule.selector) && /(^|;)display:/.test(rule.body))
  assert.deepEqual(deciding.map(rule => rule.selector), [])
})

// 公开#164: the footer's grid gives other plugins' entries rows of their own; it holds
// wherever the shell shows the footer, and stays out of the one place it hides it.
test('the shell footer is a grid wherever the shell shows it', () => {
  for (const platform of ['web', 'windows', 'mac']) {
    for (const collapsed of [false, true]) {
      const foot = shell({ platform, collapsed }).document.querySelector('.x_footArea')
      const grid = rules.some(rule => foot.matches(rule.selector) && /(^|;)display:grid/.test(rule.body))
      assert.equal(grid, !(platform === 'windows' && collapsed), `${platform} ${collapsed ? 'collapsed' : 'open'}`)
    }
  }
})

// #452: the footer lost its Connect plugins button; the account menu and the
// entries other plugins add keep the places they had.
test('the Bot footer lays out the account, another plugin\'s entry and the settings trigger', () => {
  const html = `<!doctype html><html><body><div class="x_root"><div class="x_footArea">
    <div class="x_footerActions">
      <div><span class="bt-foot-account"></span></div>
      <div><span class="x_other-plugin"></span></div>
    </div>
    <div class="x_settingsArea"><button class="x_trigger"><span class="x_label">Settings</span></button></div>
  </div></div></body></html>`
  const { document } = new JSDOM(html).window
  // The last rule that places a node is the one that counts, as in the cascade.
  const columnOf = node => {
    const placed = rules.filter(rule => node.matches(rule.selector) && /grid-column:/.test(rule.body))
    assert.ok(placed.length > 0, `no grid placement for ${node.className}`)
    return placed[placed.length - 1].body.match(/grid-column:([^;]+)/)[1]
  }
  // The account menu keeps the left of the row.
  assert.equal(columnOf(document.querySelector('.bt-foot-account')), '1')
  // Another plugin's entry takes a row of its own, above the Bot row.
  assert.equal(columnOf(document.querySelector('.x_other-plugin')), '1/-1')
  // The settings trigger keeps the right of the row.
  assert.equal(columnOf(document.querySelector('.x_settingsArea')), '3')
})

// #452: the Connect plugins button left the footer; what DS Bot puts there is
// the account menu and the way back from Agent mode.
