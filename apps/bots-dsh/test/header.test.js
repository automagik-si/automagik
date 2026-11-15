import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { headerNavigation, installHeaderNavigation } from '../src/client/header-navigation.js'
import { indexRoster } from '../src/client/sources.js'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/header.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  // ISSUE89_BASELINE=<dir> bundles <dir>/header.js instead, to show the Details tests fail on it.
  plugins: process.env.ISSUE89_BASELINE ? [{ name: 'baseline', setup(build) {
    build.onLoad({ filter: /src\/client\/header\.js$/ }, args => ({ contents: readFileSync(join(process.env.ISSUE89_BASELINE, 'header.js'), 'utf8'), resolveDir: dirname(args.path), loader: 'js' }))
  } }] : [],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, URL, URLSearchParams, setTimeout, clearTimeout,
  require: (name) => {
    const platform = {
      react: { createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx }, useContext: ctx => ctx.value, useId: () => 'dv-id', useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }), useState: initial => [initial, () => {}], useEffect: () => {}, useRef: current => ({ current }), useLayoutEffect: () => {}, useMemo: make => make(), useCallback: fn => fn, Fragment: 'fragment' },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { HeaderPill, NativeBotHeader, NativeControlsNote } = module.exports

const roster = { byId: { a: { id: 'a', name: 'Omni', sessionId: 'a' } }, roomsById: {}, bots: [], exchangeTurns: {}, questions: {} }
const hook = value => select => select(value)
const header = (actions, navigation = {}) => HeaderPill({
  sessionId: 'a',
  useRoster: hook(roster),
  useSessions: hook({ byId: {} }),
  useSessionStatus: hook(new Map()),
  useSession: hook({}),
  useActivity: hook({}),
  useMemoryNews: hook({}),
  useTurnClock: hook({}),
  useUi: hook({}),
  useLive: hook({}),
  actions,
  ...navigation,
})
const sideButton = (node) => {
  if (node === null || typeof node !== 'object') return null
  if (node.props?.['data-bt-right-sidebar'] !== undefined) return node
  for (const child of node.children ?? []) {
    const found = sideButton(child)
    if (found) return found
  }
  return null
}

test('the simple Bot header exposes a real native sidebar action, omitted without service', () => {
  let toggles = 0
  const button = sideButton(header({ hasRightSidebar: () => true, toggleRightSidebar: () => { toggles++ } }))
  assert.equal(button.props['aria-label'], 'Toggle right sidebar')
  button.props.onClick(); assert.equal(toggles, 1)
  assert.equal(sideButton(header({})), null)
  assert.equal(sideButton(header({ hasRightSidebar: () => true }, { native: true })), null)
})

test('native header contribution is opt-in per Bot and owns no native child slots', () => {
  const props = { sessionId: 'a', useRoster: hook(roster) }
  assert.equal(NativeBotHeader(props), null)
  const enabled = { ...roster, byId: { a: { id: 'canonical', advanced: true } } }
  const node = NativeBotHeader({ ...props, useRoster: hook(enabled) })
  assert.equal(node.type, HeaderPill)
  assert.equal(node.props.native, true)
  assert.equal(NativeBotHeader({ ...props, sessionId: 'plain', useRoster: hook(enabled) }), null)
})

test('Advanced native action contribution opens Live and canonical Bot settings without replacing native corner', () => {
  const calls = []
  const enabled = { ...roster, byId: { a: { id: 'canonical', name: 'Bot', advanced: true } } }
  const node = header({ hasRightSidebar: () => true, openLive: () => calls.push('live'), openSettings: (...args) => calls.push(args) }, { native: true, useRoster: hook(enabled) })
  const find = (node, label) => node?.props?.['aria-label'] === label ? node : (node?.children ?? []).map(child => find(child, label)).find(Boolean)
  find(node, 'Open Live').props.onClick()
  find(node, 'Bot settings').props.onClick()
  assert.deepEqual(calls, ['live', ['bots', 'canonical']])
  assert.equal(sideButton(node), null)
  assert.equal(node.props.className, 'bt-native-head', 'native header never gains the floating replacement marker')
})

test('Advanced explains model permission ownership and guarded compaction with actual settings actions', () => {
  const calls = []
  const node = NativeControlsNote({ sessionId: 'old', useRoster: hook({ byId: { old: { id: 'a', advanced: true } } }), actions: { openSettings: (...args) => calls.push(args) } })
  const buttons = node.children.flatMap(paragraph => paragraph.children.filter(child => child?.type === 'button'))
  assert.equal(buttons.length, 2)
  for (const button of buttons) button.props.onClick()
  assert.deepEqual(calls, [['bots', 'a'], ['bots', 'a']])
  assert.equal(NativeControlsNote({ sessionId: 'b', useRoster: hook(roster) }), null)
})

const byClass = (node, className) => {
  if (node === null || typeof node !== 'object') return null
  if (node.props?.className === className) return node
  for (const child of node.children ?? []) {
    const found = byClass(child, className)
    if (found) return found
  }
  return null
}

test('a Bot in another Conversation View can return to chat without changing its draft', () => {
  const state = { view: 'study-workspace', draft: 'Keep this draft', viewRequest: null }
  const views = [{ id: 'chat' }, { id: 'study-workspace' }]
  let details = 0
  const navigation = {
    useStore: hook(state), useConversationViews: hook(views),
    selectView: view => { state.view = view },
  }
  const actions = { toggleDetails: () => { details += 1 } }
  const away = header(actions, navigation)
  const pill = byClass(away, 'bt-pill')
  assert.equal(pill.props['aria-label'], 'Back to chat')
  assert.equal(pill.props['aria-expanded'], undefined)
  assert.equal(pill.props.title, 'Omni')
  assert.equal(byClass(away, 'bt-head-details'), null)
  pill.props.onClick()
  assert.equal(state.view, 'chat')
  assert.equal(state.draft, 'Keep this draft')
  assert.equal(details, 0)
  const restored = header(actions, navigation)
  assert.equal(byClass(restored, 'bt-pill'), null)
  byClass(restored, 'bt-head-details').props.onClick({ currentTarget: { focus() {} } })
  assert.equal(details, 1)
})

test('the header does not repeat the open chat\'s name; a small button opens its details', () => {
  const views = [{ id: 'chat' }, { id: 'trajectory' }]
  for (const view of [null, 'chat', 'uninstalled-plugin']) {
    const head = header({}, { useStore: hook({ view }), useConversationViews: hook(views), selectView() {} })
    assert.equal(byClass(head, 'bt-pill'), null)
    assert.equal(byClass(head, 'bt-head-details').props['aria-label'], 'View conversation details')
  }
  const plain = header({})
  assert.equal(byClass(plain, 'bt-pill'), null)
  assert.equal(byClass(plain, 'bt-pill-name'), null)
  assert.equal(byClass(plain, 'bt-head-details').props['aria-expanded'], false)
})

test('Details is labeled, names the panel and expands only while it shows this subject\'s details', () => {
  const cases = [['a', 'details', true], ['a', 'browser', false], ['a', 'side', false], ['b', 'details', false], [null, 'details', false]]
  for (const [details, view, expanded] of cases) {
    const button = byClass(header({}, { useUi: hook({ details, view }) }), 'bt-head-details')
    assert.equal(button.props['aria-expanded'], expanded, `${details}/${view}`)
  }
  for (const [details, view] of cases) {
    const button = byClass(header({}, { useUi: hook({ details, view }) }), 'bt-head-details')
    assert.equal(button.props['aria-controls'], 'bt-conversation-panel')
    assert.ok(button.children.includes('Details'), 'the label is visible text, not only a tooltip')
  }
})

test('Details toggles the current Bot or group, never a plain or native wish thread', () => {
  const calls = []
  let focused = 0
  const actions = { toggleDetails: id => calls.push(id) }
  for (const sessionId of ['a', 'group', 'wish', 'plain']) {
    const head = header(actions, { sessionId, useRoster: hook({ ...roster, roomsById: { group: { id: 'group', name: 'Team', members: ['a'] } } }) })
    const button = byClass(head, 'bt-head-details')
    if (sessionId === 'wish' || sessionId === 'plain') assert.equal(button, null)
    else {
      assert.equal(button.props['data-details-subject'], sessionId)
      button.props.onClick({ currentTarget: { focus() { focused += 1 } } })
    }
  }
  assert.deepEqual(calls, ['a', 'group'])
  assert.equal(focused, 2, 'the trigger takes focus before toggling, so closing can return it')
})

// Issue #337: the pill's arrow reads data-expanded, so aria-expanded stays on the Details
// button alone, and the memory notice still hides the arrow.
test('the pill arrow is styled from data-expanded, never from aria-expanded', () => {
  const css = readFileSync(fileURLToPath(new URL('../src/client/styles.js', import.meta.url)), 'utf8')
  assert.doesNotMatch(css, /\.bt-pill\[aria-expanded/, 'no pill selector reads aria-expanded')
  const pillRules = css.split('\n').filter(line => line.includes('.bt-pill'))
  assert.deepEqual(pillRules.filter(line => line.includes('aria-expanded')), [],
    'no .bt-pill rule, arrow included, reads aria-expanded')
  assert.match(css, /\.bt-pill:hover \.bt-pill-go,\.bt-pill:focus-visible \.bt-pill-go,\.bt-pill\[data-expanded=true\] \.bt-pill-go\{width:18px;margin-left:0;opacity:1;filter:none;transform:none\}/)
  assert.match(css, /\.bt-pill\[data-expanded=true\] \.bt-pill-go svg\{transform:rotate\(180deg\)\}/)
  assert.match(css, /\.bt-pill\[data-memory=updated\]:is\(:hover,:focus-visible,\[data-expanded=true\]\) \.bt-pill-go\{width:0;margin-left:-8px;opacity:0;filter:blur\(6px\);transform:translateX\(-6px\)\}/)
})

const byClassAll = (node, className, found = []) => {
  if (node === null || typeof node !== 'object') return found
  if (node.props?.className === className) found.push(node)
  for (const child of node.children ?? []) byClassAll(child, className, found)
  return found
}

test('only the Details pill names the pane and takes focus before the icon buttons do', () => {
  const calls = []
  const actions = {
    hasRightSidebar: () => true, toggleRightSidebar() { calls.push('sidebar') },
    openLive() { calls.push('live') }, toggleDetails: id => calls.push(`toggle:${id}`),
  }
  const advanced = { ...roster.byId.a, advanced: true }
  const head = header(actions, {
    native: true, useRoster: hook({ ...roster, byId: { a: advanced } }),
    useUi: hook({ details: 'a', view: 'browser' }),
  })
  const buttons = byClassAll(head, 'bt-head-details')
  assert.equal(buttons.length, 3, 'Bot settings, Live and Details share the class')
  const details = buttons.find(button => button.props['aria-controls'] === 'bt-conversation-panel')
  assert.ok(details, 'the Details button controls the existing panel')
  assert.equal(details.props['aria-label'], 'View conversation details')
  assert.equal(details.props['data-details-subject'], 'a')
  assert.equal(details.props['aria-expanded'], false, 'the Browser view is not the Details pane')
  assert.deepEqual(details.children.slice(1), ['Details'], 'the visible label follows the icon')
  for (const other of buttons.filter(button => button !== details)) {
    assert.equal(other.props['aria-controls'], undefined,
      `${other.props['aria-label']} controls no pane`)
    assert.equal(other.props['data-details-subject'], undefined,
      `${other.props['aria-label']} names no subject`)
  }
  details.props.onClick({ currentTarget: { focus() { calls.push('focus') } } })
  assert.deepEqual(calls, ['focus', 'toggle:a'], 'the trigger takes focus before the panel opens')
})

test('a native Agent thread gets no Bot Details pill, while a Bot part opens its Bot', () => {
  const indexed = indexRoster({
    bots: [{ id: 'bot', name: 'Omni', sessionId: 'part-2', parts: ['bot', 'part-2'] }],
    rooms: [],
    agents: [{ id: 'agent', kind: 'dsh', name: 'Agent', sessions: ['wish-thread'] }],
  })
  assert.equal(indexed.agentOf['wish-thread'], 'agent')
  assert.equal(indexed.byId['wish-thread'], undefined, 'the native thread is not a Bot subject')
  const native = header({}, { sessionId: 'wish-thread', useRoster: hook(indexed) })
  assert.equal(byClass(native, 'bt-head-details'), null, 'the native thread keeps its host Details')
  const part = header({}, { sessionId: 'part-2', useRoster: hook(indexed) })
  assert.equal(indexed.byId['part-2'], indexed.byId.bot, 'every Bot part resolves to its Bot')
  assert.equal(byClass(part, 'bt-head-details').props['data-details-subject'], 'part-2')
})

test('a multi-part Bot\'s part header reads expanded whether Details opened by the part or the Bot id', () => {
  const indexed = indexRoster({
    bots: [{ id: 'bot', name: 'Omni', sessionId: 'part-2', parts: ['bot', 'part-2', 'part-3'] }, { id: 'other', name: 'Other' }],
    rooms: [{ id: 'group', name: 'Team', members: ['bot'] }],
  })
  const cases = [['part-2', 'details', true], ['bot', 'details', true], ['part-3', 'details', true],
    ['bot', 'browser', false], ['part-2', 'side', false], ['other', 'details', false],
    ['group', 'details', false], [null, 'details', false]]
  for (const [details, view, expanded] of cases) {
    const part = header({}, { sessionId: 'part-2', useRoster: hook(indexed), useUi: hook({ details, view }) })
    assert.equal(byClass(part, 'bt-head-details').props['aria-expanded'], expanded, `${details}/${view}`)
  }
})

test('the replacement header shares DSH\'s store and navigation injection without declaring its children again', () => {
  const store = {}
  const views = { getSnapshot: () => [{ id: 'chat' }] }
  const roster = {}
  const picked = []
  const bound = { setView: view => picked.push(view) }
  const source = { options: {},
    store,
    children: { 'conversation.session.header.actions': { kind: 'list', scope: 'session' } },
    inject: (sessionId, actions) => ({ hooks: { conversationViews: views }, selectView: view => { assert.equal(sessionId, 'a'); actions.setView(view) } }),
  }
  const own = { actions: { openMemory() {} }, hooks: { roster } }
  const options = headerNavigation([{ options: {} }, source], () => own)
  assert.equal(options.store, store)
  assert.equal(options.children, undefined)
  const injected = options.inject('a', bound)
  assert.equal(injected.hooks.conversationViews, views)
  assert.equal(injected.hooks.roster, roster)
  assert.equal(injected.actions, own.actions)
  injected.selectView('chat')
  assert.deepEqual(picked, ['chat'])
  const absent = headerNavigation([], () => own)
  assert.equal(absent.store, undefined)
  assert.deepEqual(absent.inject('a'), own)
})

test('the Bot header follows a later host header registration and releases its subscription', () => {
  const entries = []
  const listeners = new Set()
  let registrations = 0
  const slots = {
    entries: () => entries,
    subscribe: (_name, listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    register: ({ priority, store, inject }, component) => {
      registrations += 1
      const entry = { options: { priority }, store, inject, component }
      entries.push(entry)
      return () => { const at = entries.indexOf(entry); if (at !== -1) entries.splice(at, 1) }
    },
  }
  const changed = () => { for (const listener of listeners) listener() }
  const own = { hooks: {}, actions: {} }
  const stop = installHeaderNavigation(slots, () => own, HeaderPill, -100)
  assert.equal(entries[0].store, undefined)
  const store = {}
  const host = { options: { priority: 0 }, component() {}, store, inject: () => ({ selectView() {} }) }
  entries.push(host)
  changed()
  assert.equal(entries.find(entry => entry.component === HeaderPill).store, store)
  assert.equal(registrations, 2)
  changed()
  assert.equal(registrations, 2, 'the replacement does not react to its own registration')
  entries.splice(entries.indexOf(host), 1)
  changed()
  assert.equal(entries[0].store, undefined, 'a removed host releases its old navigation face')
  stop()
  assert.equal(entries.length, 0)
  assert.equal(listeners.size, 0)
})
