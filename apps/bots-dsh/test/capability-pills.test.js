import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// Each Bot says what it can be asked for (#318): Computer (DSH's shell and file tools),
// Channels (it operates the linked Omni) and Leads the team (a Main Bot), in that order,
// in its sidebar row and on its profile. The sidebar and the drawer run on a minimal React
// stand-in, as in sidebar-main-row.test.js and right-panel.test.js.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: "export { TeamSidebar } from './src/client/sidebar.js'\nexport { DetailsDrawer } from './src/client/details-drawer.js'\nexport { pillsOf } from './src/client/capability-pills.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id', useCallback: fn => fn,
  // The bundled Deep View widgets make a React context when their module loads.
  createContext: value => ({ Provider: 'Provider', value }), useContext: context => context.value,
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, URL, URLSearchParams, setTimeout, clearTimeout,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : name === '@deepseek-ai/dsh-client-ui-primitives' ? { MarkdownText: () => null } : {}),
  window: { innerWidth: 1280, matchMedia: () => ({ matches: false }) },
  document: { body: { dataset: {} } },
  matchMedia: () => ({ matches: false }),
})
const { TeamSidebar, DetailsDrawer, pillsOf } = module.exports

// The fixture team: the Main Bot, the Omni Bot, the executor and a Bot of the user's own.
const pip = { id: 'pip', name: 'Pip', role: 'Orchestrator', sessionId: 'pip', createdAt: 1 }
const omni = { id: 'omni', name: 'Omni', role: 'Channel keeper', kind: 'omni', sessionId: 'omni', createdAt: 2 }
const genie = { id: 'genie', name: 'Genie', role: 'Executor', kind: 'genie', sessionId: 'genie', createdAt: 3 }
const writer = { id: 'writer', name: 'Writer', sessionId: 'writer', createdAt: 4 }
const team = (fields = {}) => ({
  bots: [pip, omni, genie, writer], rooms: [], agents: [], byId: { pip, omni, genie, writer }, roomsById: {}, agentOf: {},
  mainBotId: 'pip', mainBotIds: ['pip'], exchangeTurns: {}, questions: {}, ready: true, memory: false, omniLinked: true, ...fields,
})

const TIPS = {
  computer: 'Has a computer: ask it for code, files and commands.',
  channels: 'Works in your Omni channels: ask it to read, send or answer messages there.',
  leads: 'Leads the team: ask it to plan work, make Bots and hand tasks to the right one.',
}
const LABELS = { computer: 'Computer', channels: 'Channels', leads: 'Leads the team' }

const find = (node, match, found = []) => {
  if (Array.isArray(node)) { node.forEach(child => find(child, match, found)); return found }
  if (!node || typeof node !== 'object') return found
  if (match(node)) found.push(node)
  find(node.props?.children, match, found)
  return found
}
const named = name => node => node.type?.name === name
const textOf = node => (typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join('') : node?.props ? textOf(node.props.children) : '')
// The pills a rendered tree shows, as [key, label, tooltip], after rendering BotPills as React would.
const pillsIn = (tree) => {
  const rendered = find(tree, named('BotPills')).map(node => node.type(node.props))
  return find(rendered, node => node.props?.['data-pill'] !== undefined)
    .map(node => [node.props['data-pill'], textOf(node), node.props.title])
}
const expected = keys => keys.map(key => [key, LABELS[key], TIPS[key]])

function rows({ roster = team(), wide = true } = {}) {
  const tree = TeamSidebar({
    wide, actions: {},
    useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
    useSessionStatus: pick => pick(new Map()),
    useSessionRetainInfo: (_id, pick) => pick(undefined),
    useActivity: pick => pick({}),
    useWork: pick => pick({ approvals: [], rooms: {}, waiting: {} }),
  })
  return Object.fromEntries(find(tree, named('BotRow')).map(row => [row.props.bot.id, row.type(row.props)]))
}

const hook = value => select => select(value)
const profile = (id, roster = team()) => DetailsDrawer({
  sessionId: id, roster, actions: {},
  useSessions: hook({ byId: {} }), useSessionStatus: hook(new Map()), useActivity: hook({}),
  useWork: hook({ bots: {}, approvals: [] }), useBrowserTabs: hook({}), useBrowserPages: hook({}),
})

const LINKED = { pip: ['channels', 'leads'], omni: ['channels'], genie: ['computer'], writer: ['computer'] }

test('with an Omni linked, each sidebar row shows exactly the pills its Bot has, with their tooltips', () => {
  const shown = rows()
  assert.deepEqual(Object.keys(shown).sort(), ['genie', 'omni', 'pip', 'writer'])
  for (const [id, keys] of Object.entries(LINKED)) assert.deepEqual(pillsIn(shown[id]), expected(keys), id)
  // The row's own label names them too, for a screen reader.
  assert.match(shown.pip.props['aria-label'], /^Pip, Orchestrator, Main Bot, Channels, Leads the team/)
  assert.match(shown.genie.props['aria-label'], /^Genie, Computer/)
})

test('with an Omni linked, each profile shows the same pills under the name', () => {
  for (const [id, keys] of Object.entries(LINKED)) assert.deepEqual(pillsIn(profile(id)), expected(keys), id)
})

test('with no Omni linked, nothing takes the computer away and no Bot works in channels', () => {
  const roster = team({ omniLinked: false })
  const shown = rows({ roster })
  const unlinked = { pip: ['computer', 'leads'], omni: ['computer'], genie: ['computer'], writer: ['computer'] }
  for (const [id, keys] of Object.entries(unlinked)) {
    assert.deepEqual(pillsIn(shown[id]), expected(keys), `row ${id}`)
    assert.deepEqual(pillsIn(profile(id, roster)), expected(keys), `profile ${id}`)
  }
})

test('no pill means no pill box, and the narrow rail shows no pills', () => {
  // Every Bot of today's teams has a computer or works in channels, so an empty list comes
  // only from what the client cannot read as a Bot; it draws nothing.
  assert.deepEqual([...pillsOf(team(), undefined)], [])
  const [box] = find(rows().writer, named('BotPills'))
  assert.equal(box.type({ ...box.props, bot: undefined }), null)
  // An answer without omniLinked (before the first state answer) reads as no Omni linked.
  assert.deepEqual([...pillsOf(team({ omniLinked: undefined }), pip)], ['computer', 'leads'])
  for (const row of Object.values(rows({ wide: false }))) assert.equal(find(row, named('BotPills')).length, 0)
})

function start(services) {
  const home = mkdtempSync(join(tmpdir(), 'omni-pills-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, mainBotIds: ['m1'], revision: 1, bots: { m1: { id: 'm1', name: 'Omni', role: '', instructions: '', createdAt: 1 } }, rooms: {}, exchanges: [], exchangeTurns: {}, questions: {} }))
  const ctx = fakeContext({ services })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, { home })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/omni-ui', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  return { call, stop: async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) } }
}

test('the state answer says whether the channels plugin operates an Omni here', async (t) => {
  const cases = [
    [undefined, false],
    [{ omniNamed: () => false }, false],
    [{ omniNamed: () => true }, true],
    // A channels plugin from before omniNamed reads its omni.url, as its own operatesHere does.
    [{ config: { omni: { url: 'http://omni.local' } } }, true],
    [{ omniNamed: () => { throw new Error('broken') } }, false],
  ]
  for (const [channels, linked] of cases) {
    const { call, stop } = start(channels === undefined ? {} : { omniChannels: channels })
    t.after(stop)
    const answer = await call('state')
    assert.equal(answer.value.omniLinked, linked, JSON.stringify(channels))
    // An unchanged answer carries it too: it changes without a new revision.
    assert.equal((await call('state', { since: answer.value.revision, models: answer.value.modelsKey })).value.omniLinked, linked)
  }
})
