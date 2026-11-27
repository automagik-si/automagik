import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The first Main Bot is a sidebar row like the others: pinned first, a larger avatar
// wearing the crown, its role beside its name, and the status line, badges and unread dot
// every row has. The sidebar runs on a minimal React stand-in, as in sidebar-switch.test.js:
// components are plain functions, and the test calls the ones it looks into.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: "export { TeamSidebar } from './src/client/sidebar.js'\nexport { badges, botChildren, botChannels } from './src/client/extend.js'",
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
const window = { innerWidth: 1280, matchMedia: () => ({ matches: false }) }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : {}),
  window,
  document: { body: { dataset: {} } },
  matchMedia: () => ({ matches: false }),
})
const { TeamSidebar, badges, botChildren, botChannels } = module.exports

const pip = { id: 'pip', name: 'Pip', role: 'Orchestrator', sessionId: 'pip', createdAt: 1 }
const omni = { id: 'omni', name: 'Omni', role: 'Channel keeper', kind: 'omni', sessionId: 'omni', createdAt: 2 }
const roster = {
  bots: [pip, omni], rooms: [], agents: [], byId: { pip, omni }, roomsById: {}, agentOf: {},
  mainBotId: 'pip', mainBotIds: ['pip'], exchangeTurns: {}, questions: {}, ready: true,
}

const find = (node, match, found = []) => {
  if (Array.isArray(node)) { node.forEach(child => find(child, match, found)); return found }
  if (!node || typeof node !== 'object') return found
  if (match(node)) found.push(node)
  find(node.props?.children, match, found)
  return found
}
const named = name => node => node.type?.name === name

function sidebar({ wide = true, unread = false, actions = {}, team = roster, stops = [] } = {}) {
  const tree = TeamSidebar({
    wide, actions,
    useRoster: pick => pick(team), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
    useSessionStatus: pick => pick(new Map(unread ? [['pip', { completionUnread: true }]] : [])),
    useSessionRetainInfo: (_id, pick) => pick(undefined),
    useActivity: pick => pick({}),
    useWork: pick => pick({ approvals: [], rooms: {}, waiting: {}, stops }),
  })
  const rows = find(tree, named('BotRow'))
  // A row renders by calling it with its props, as React would.
  const render = row => row.type(row.props)
  // The open sidebar is the new left bar: its rows, and what hangs under a row.
  const bar = tree?.type?.name === 'LeftBar' ? tree : null
  const teamRows = () => find(bar.type(bar.props), named('TeamRows'))[0]
  const after = (id, bot = {}) => bar.props.renderAfter({ kind: 'bot', id, bot })
  return { tree, rows, render, bar, teamRows, after }
}

test('the first Main Bot is the bar\'s first row, then the others; what hangs under it follows it', () => {
  const { tree, teamRows, after } = sidebar()
  assert.equal(find(tree, node => node.props?.className === 'bt-tile' || node.props?.className === 'bt-tile-wrap').length, 0, 'no tile')
  const rows = teamRows()
  assert.equal(rows.props.team.frontId, 'pip')
  assert.deepEqual([...rows.props.team.bots.map(bot => bot.id)], ['pip', 'omni'])
  // Its children (what other plugins hang under a Bot) follow it.
  assert.ok(find(after('pip'), named('BotChildren')).some(node => node.props.bot.id === 'pip'))
})

test('a Bot served by a channel source keeps the team\'s old rows off, and its chats open through the source', (t) => {
  const opened = []
  const source = { id: 'fake-channels', botId: 'pip', useChannels: () => [], open: chatId => opened.push(chatId) }
  t.after(botChannels.register(source))
  const { bar, teamRows, after } = sidebar()
  const pipRow = teamRows().props.team.bots.find(bot => bot.id === 'pip')
  assert.equal(pipRow.channelSource, source, 'the bar reads the one source that serves it')
  assert.equal(find(after('pip', pipRow), named('BotChildren')).length, 0, 'the bar draws its channels instead')
  assert.equal(find(after('pip', pipRow), named('BotThreads')).length, 1, 'its running tasks stay')
  bar.props.open({ kind: 'chat', id: 'chat-1', botId: 'pip', source })
  assert.deepEqual(opened, ['chat-1'])
})

test('rows other plugins hang under a Bot get the rows\' own props, and opening one folds the sidebar', (t) => {
  const Thread = () => null
  t.after(botChildren.register({ id: 'thread', Component: Thread }))
  const calls = []
  const { after } = sidebar({ actions: { openSession: id => calls.push(['open', id]), toggleSidebar: () => calls.push(['fold']) } })
  const children = find(after('pip'), named('BotChildren')).find(node => node.props.bot.id === 'pip')
  const [thread] = [children.type(children.props)].flat()
  for (const key of ['bot', 'roster', 'actions', 'wide', 'useSessions', 'useUi', 'useSessionStatus', 'useSessionRetainInfo', 'useActivity', 'useWork']) assert.ok(thread.props[key] !== undefined, key)
  window.innerWidth = 800
  t.after(() => { window.innerWidth = 1280 })
  thread.props.actions.openSession('thread-1')
  assert.deepEqual(calls, [['open', 'thread-1'], ['fold']])
})

test('the Team row and legacy sidebar show the Genie tag and the shared child outlet follows the role', (t) => {
  const WishRows = () => null
  const OtherRows = () => null
  t.after(botChildren.register({ id: 'genie-wishes', Component: WishRows }))
  t.after(botChildren.register({ id: 'other-rows', Component: OtherRows }))
  const tagged = tree => find(tree, node => node.props?.className === 'bt-tag' && node.props.children.includes('Genie')).length === 1
  for (const [kind, roles, prefs, showTag, showWishes] of [
    ['genie', undefined, {}, true, true],
    ['genie', [], {}, false, false],
    ['genie', [], { roles: false }, false, true],
    [undefined, undefined, {}, false, false],
  ]) {
    const record = { id: 'role-fixture', name: 'Bot', kind, ...(roles === undefined ? {} : { roles }) }
    const team = { ...roster, bots: [record], byId: { [record.id]: record }, mainBotId: record.id, mainBotIds: [record.id], prefs }
    const wide = sidebar({ team })
    const rows = wide.teamRows()
    const row = find(rows.type(rows.props), node => node.type === 'button' && node.props['data-id'] === record.id)[0]
    assert.equal(tagged(row), showTag)
    const outlet = find(wide.after(record.id), named('BotChildren'))[0]
    const children = outlet.type(outlet.props)
    assert.equal(find(children, node => node.type === WishRows).length, Number(showWishes))
    assert.equal(find(children, node => node.type === OtherRows).length, 1)
    const [legacy] = sidebar({ wide: false, team }).rows
    assert.equal(tagged(legacy.type({ ...legacy.props, wide: true })), showTag)
  }
})

test('the child outlet keeps registered rows when the roster is missing', (t) => {
  const WishRows = () => null
  const OtherRows = () => null
  t.after(botChildren.register({ id: 'genie-wishes', Component: WishRows }))
  t.after(botChildren.register({ id: 'other-rows', Component: OtherRows }))
  const record = { id: 'detached', name: 'Genie', kind: 'genie', roles: [] }
  const { after } = sidebar({ team: { ...roster, bots: [record], byId: { [record.id]: record } } })
  const outlet = find(after(record.id), named('BotChildren'))[0]
  const children = outlet.type({ ...outlet.props, roster: undefined })
  assert.equal(find(children, node => node.type === WishRows).length, 1)
  assert.equal(find(children, node => node.type === OtherRows).length, 1)
})

test('badges other plugins add still end a Bot\'s row, with the row\'s Bot, and never a DSH bot\'s', (t) => {
  const Badge = () => null
  t.after(badges.register({ id: 'events', Component: Badge }))
  const brain = { id: 'brain', kind: 'dsh', name: 'Brain', sessions: ['session-brain'], createdAt: 3 }
  const { bar, teamRows } = sidebar({ team: { ...roster, agents: [brain], agentsById: { brain } } })
  const rows = teamRows()
  const pipRow = rows.props.team.bots.find(bot => bot.id === 'pip')
  const end = bar.props.renderEnd({ kind: 'bot', id: 'pip', bot: pipRow })
  const [badge] = [end.type(end.props)].flat()
  assert.equal(badge.type, Badge)
  assert.equal(badge.props.bot.id, 'pip')
  assert.equal(bar.props.renderEnd({ kind: 'bot', id: 'brain', bot: { dsh: 'agent' } }), null)
  assert.equal(rows.props.renderEnd, bar.props.renderEnd)
})

test('the Main Bot\'s row shows unread like any other', () => {
  const bots = sidebar({ unread: true }).teamRows().props.team.bots
  assert.deepEqual(JSON.parse(JSON.stringify(bots.map(bot => [bot.id, bot.unread]))), [['pip', true], ['omni', false]])
})

test('in the narrow rail the crowned row keeps the crown at the rail size', () => {
  const { rows, render } = sidebar({ wide: false })
  const row = render(rows[0])
  const [avatar] = find(row, named('BotAvatar'))
  assert.equal(avatar.props.size, 36)
  assert.equal(avatar.props.crown, true)
  assert.equal(row.props.title, 'Pip')
})

test('a Bot whose plugin is not installed says so, in the bar and in the rail', () => {
  const missing = { ...omni, installed: false, reason: 'the @automagik/omni-channels-dsh plugin is missing from this DSH' }
  const team = { ...roster, bots: [pip, missing], byId: { pip, missing } }
  // The wide bar's left-bar status is not idle.
  const barRow = sidebar({ team }).teamRows().props.team.bots.find(bot => bot.id === 'omni')
  assert.equal(barRow.status, 'not-installed')
  // The narrow rail's row says it in its accessible name and its line, with the reason.
  const { rows, render } = sidebar({ wide: false, team })
  const row = render(rows[1])
  assert.match(row.props['aria-label'], /Not installed/)
  assert.match(JSON.stringify(row), /Not installed/)
  assert.match(JSON.stringify(row), /plugin is missing/)
})

test('the wide bar row carries the reason, and the dead missing-preview line is gone', () => {
  const missing = { ...omni, installed: false, reason: 'the @automagik/omni-channels-dsh plugin is missing from this DSH' }
  const team = { ...roster, bots: [pip, missing], byId: { pip, missing } }
  const rows = sidebar({ team }).teamRows()
  // The bar draws its rows through TeamRows; call it as React would.
  const bots = rows.props.team.bots.map(bot => bot.id === 'omni' ? { ...bot, roleTag: 'Maintainer', unread: true } : bot)
  const list = rows.type({ ...rows.props, team: { ...rows.props.team, bots } })
  const [row] = find(list, node => node.type === 'button' && node.props?.['data-id'] === 'omni')
  assert.equal(row.props['aria-label'], undefined, 'keep the accessible name from the row contents')
  assert.equal(row.props['aria-description'], missing.reason)
  for (const word of ['Omni', 'Maintainer', 'Unread activity']) {
    assert.ok(find(row, node => node.props?.children?.includes(word)).length > 0, word)
  }
  // The mark's own title says why too, where a pointer or a reader arrives at it.
  const [status] = find(row, node => node.type?.name === 'Status')
  assert.equal(status.type(status.props).props.title, `Not installed · ${missing.reason}`)
  // BotRow's wide-only preview was never reachable: the bar does not draw that class.
  assert.equal(find(list, node => String(node.props?.className).includes('bt-row-preview-missing')).length, 0)
  const barSource = readFileSync(new URL('../src/client/sidebar.js', import.meta.url), 'utf8')
  assert.equal(barSource.includes('bt-row-preview-missing'), false, 'the dead preview branch is gone')
  const sheet = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  assert.equal(sheet.includes('bt-row-preview-missing'), false, 'its sheet rule is gone too')
})

test('a DSH bot row wears DSH\'s blue whale, not a generic terminal mark', () => {
  const brain = { id: 'brain', kind: 'dsh', name: 'Cogna Brain', sessions: ['session-brain'], createdAt: 3 }
  const team = { ...roster, agents: [brain], agentsById: { brain } }
  const rows = sidebar({ team }).teamRows()
  const row = rows.props.team.bots.find(bot => bot.id === 'brain')
  assert.deepEqual([row.name, row.dsh], ['Cogna Brain', 'agent'])
  const mark = rows.props.renderArt(row, 28, 'idle')
  assert.equal(mark.type.name, 'BotMark')
  assert.equal(mark.props.look.shape, 'whale')
  assert.equal(mark.props.look.color, 'blue')
  // The tasks row keeps its own mark; only a DSH bot wears the whale.
  assert.equal(rows.props.renderArt({ id: 'tasks', dsh: 'tasks' }, 28, 'idle').type.name, 'TasksIcon')
})

test('both sidebar variants use the exact package name and hide it with roles off', () => {
  const record = { id: 'fixture', name: 'Fixture', roles: [{ id: 'constructor', version: '1.0.0', attachedAt: '', grants: [] }] }
  const key = 'constructor'
  const details = { version: '1.0.0', sha256: 'a'.repeat(64) }
  const team = {
    ...roster, bots: [record], byId: { [record.id]: record }, mainBotId: record.id, mainBotIds: [record.id],
    roleCatalog: { roles: [{ id: key, version: details.version, name: '<Catalog fixture>', capabilities: [] }] },
    roleDetails: { [key]: { installed: details, catalog: details } },
  }
  const tags = tree => find(tree, node => node.props?.className === 'bt-tag').map(node => node.props.children[0])
  for (const [prefs, catalogDigest, expected] of [
    [{}, details.sha256, ['<Catalog fixture>']],
    [{}, 'b'.repeat(64), [key]],
    [{ roles: false }, details.sha256, []],
  ]) {
    const live = { ...team, prefs, roleDetails: { [key]: { installed: details, catalog: { ...details, sha256: catalogDigest } } } }
    const rows = sidebar({ team: live }).teamRows()
    const row = find(rows.type(rows.props), node => node.type === 'button' && node.props['data-id'] === record.id)[0]
    assert.deepEqual(tags(row), expected)
    const [legacy] = sidebar({ wide: false, team: live }).rows
    assert.deepEqual(tags(legacy.type({ ...legacy.props, wide: true })), expected)
  }
})

test('#2132 the sidebar preview and accessible label describe confirmed runs', () => {
  const ran = { botId: 'pip', open: true, ran: true }
  const mixed = [{ ...ran, ran: undefined }, ran]
  for (const [stops, expected] of [[[ran], 'A step ran unheld'], [mixed, 'A step stopped on a permission']]) {
    const { rows } = sidebar({ wide: false, stops })
    const pip = rows.find(row => row.props.bot.id === 'pip')
    const row = pip.type({ ...pip.props, wide: true })
    const [button] = find(row, node => node.type === 'button' && node.props['aria-label']?.includes('Pip'))
    assert.ok(button.props['aria-label'].includes(expected))
    assert.ok(find(button, node => node.type === 'span' && node.props.children?.includes(expected)).length)
  }
})
