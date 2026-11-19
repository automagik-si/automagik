import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The show_settings card draws the very page the Settings dialog draws (SettingsPage), from
// the live roster: one page, two places, one way to save.
const plugin = fileURLToPath(new URL('..', import.meta.url))
const bundle = async contents => (await build({
  stdin: { contents, resolveDir: plugin },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})).outputFiles[0].text

// A stand-in React that draws one tree; useState keeps what the test hands it.
let states = []
const react = {
  Component: class {}, createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useCallback: fn => fn, useRef: current => ({ current }), useMemo: make => make(), useId: () => 'id',
  useState: (initial) => {
    const value = states.length > 0 ? states.shift() : (typeof initial === 'function' ? initial() : initial)
    return [value, () => {}]
  },
  createContext: value => ({ Provider: 'Provider', value }), useContext: context => context.value,
}
const load = (text) => {
  const module = { exports: {} }
  runInNewContext(text, {
    module, exports: module.exports,
    window: { innerWidth: 1280, matchMedia: () => ({ matches: false }) },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}, setTimeout, clearTimeout, Promise,
    require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : new Proxy({}, { get: (_, key) => key })),
  })
  return module.exports
}
const card = load(await bundle("export * from './src/client/settings-card.js'; export { parseProposal, applySteps } from './src/shared/proposals.js'"))
const settings = load(await bundle("export { PAGE_ICONS, PageBoundary, SettingsPage, SettingsDialog } from './src/client/settings.js'; export { SETTINGS_PAGES } from './src/shared/settings-pages.js'"))

const walk = (node, match, out = []) => {
  if (Array.isArray(node)) { node.forEach(child => walk(child, match, out)); return out }
  if (!node || typeof node !== 'object') return out
  if (match(node)) out.push(node)
  walk(node.props?.children, match, out)
  return out
}
const textOf = node => (typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join('') : node?.props ? textOf(node.props.children) : '')

const writer = { id: 'b2', name: 'Writer', color: 'blue' }
const room = { id: 'r1', name: 'Team', members: ['b2'] }
const roster = { byId: { b2: writer }, roomsById: { r1: room }, bots: [writer], rooms: [room], models: [], prefs: {} }
const args = values => ({ text: key => values[key], value: key => values[key] })

// The component each page of the shared list must draw. A page without a branch in
// SettingsPage would draw nothing here, which is the empty-card defect this guards.
const PAGE_COMPONENTS = {
  general: 'GeneralPage', models: 'ProvidersPage', bots: 'BotsPage', groups: 'GroupsPage',
  connectors: 'ConnectorsPage', capabilities: 'CapabilitiesPage', browser: 'BrowserPage',
  computer: 'ComputerPage', schedules: 'SchedulesPage', usage: 'UsagePage', secrets: 'SecretsPage',
  'agent-access': 'AgentAccessPage', privacy: 'PrivacyPage', feedback: 'FeedbackPage', about: 'AboutPage',
}

test('the card opens a Bot\'s own form, a group\'s, or a Bot\'s view of a page', () => {
  const bots = card.settingsTarget({ page: 'bots', bot: 'writer' }, roster)
  assert.equal(bots.known, true)
  assert.equal(bots.bot, writer)
  assert.equal(bots.id, 'b2')
  assert.equal(bots.title, 'Writer')
  const groups = card.settingsTarget({ page: 'groups', group: 'Team' }, roster)
  assert.equal(groups.room, room)
  assert.equal(groups.id, 'r1')
  assert.equal(card.settingsTarget({ page: 'usage', bot: 'Writer' }, roster).id, 'owner:b2')
  assert.equal(card.settingsTarget({ page: 'schedules', bot: 'b2' }, roster).id, 'b2')
  assert.equal(card.settingsTarget({ page: 'computer', bot: 'Writer' }, roster).id, null, 'a Bot named on another page opens the page itself')
  assert.equal(card.settingsTarget({ page: 'computer' }, roster).title, 'Computer use')
})

test('a plugin page is known only when this window has it', () => {
  const plugins = [{ id: 'acp-agents', label: 'Agents', Component: () => null }]
  const shown = card.settingsTarget({ page: 'plugin:acp-agents' }, roster, plugins)
  assert.equal(shown.known, true)
  assert.equal(shown.pluginPage, plugins[0])
  assert.equal(shown.title, 'Agents')
  assert.equal(card.settingsTarget({ page: 'plugin:gone' }, roster, plugins).known, false)
})

test('a refused or unfinished call draws no card', () => {
  const actions = { openSettings() {} }
  for (const props of [{ done: false, content: '' }, { done: true, isError: true, content: 'Showing Settings → general in the chat.' }, { done: true, content: 'No Settings page named "x".' }]) {
    const drawn = card.SettingsCall({ args: args({ page: 'general' }), roster, actions, ...props })
    assert.equal(walk(drawn, node => node.type === card.SettingsCard).length, 0)
  }
  const drawn = card.SettingsCall({ args: args({ page: 'general', note: 'Look here' }), done: true, content: 'Showing Settings → general in the chat.', roster, actions })
  const [shown] = walk(drawn, node => node.type === card.SettingsCard)
  assert.equal(shown.props.target.page, 'general')
  assert.equal(shown.props.note, 'Look here')
})

test('closed, the card is one row that opens the page in Settings', () => {
  const opened = []
  states = [false, '']
  const tree = card.SettingsCard({ target: card.settingsTarget({ page: 'bots', bot: 'Writer' }, roster), roster, actions: { openSettings: (...where) => opened.push(where) } })
  assert.equal(walk(tree, node => node.props?.className?.includes?.('bt-setcard-body')).length, 0)
  const [button] = walk(tree, node => node.type === 'button' && textOf(node) === 'Open in Settings')
  button.props.onClick()
  assert.deepEqual(opened, [['bots', 'b2']])
})

test('open, the card draws the Settings dialog\'s own page with the same props', () => {
  const release = card.setSettingsPages({ PAGE_ICONS: settings.PAGE_ICONS, PageBoundary: settings.PageBoundary, SettingsPage: settings.SettingsPage })
  try {
    states = [true, '']
    const actions = { openSettings() {} }
    const tree = card.SettingsCard({ target: card.settingsTarget({ page: 'bots', bot: 'Writer' }, roster), roster, actions })
    const [page] = walk(tree, node => node.type === settings.SettingsPage)
    assert.ok(page, 'the page is SettingsPage itself')
    assert.equal(page.props.shown, 'bots')
    assert.equal(page.props.bot, writer)
    assert.equal(page.props.roster, roster)
    assert.equal(page.props.actions, actions)
    const drawn = settings.SettingsPage(page.props)
    assert.equal(walk(drawn, node => typeof node.type === 'function' && node.type.name === 'BotSettingsForm').length, 1)
  } finally {
    release()
  }
})

test('every page the Settings list has draws its own component, not an empty fragment', () => {
  const actions = { openSettings() {} }
  const draw = shown => settings.SettingsPage({ shown, roster, actions, run: async () => true, useUpdate: () => undefined, close() {} })
  assert.equal(Array.from(settings.SETTINGS_PAGES, ([id]) => id).sort().join(' '), Object.keys(PAGE_COMPONENTS).sort().join(' '),
    'the test names every page the list has, so a page added without a branch fails here')
  for (const [page] of settings.SETTINGS_PAGES) {
    const components = walk(draw(page), node => typeof node.type === 'function')
    assert.equal(components.length, 1, `${page} draws one Settings component`)
    assert.equal(components[0].type.name, PAGE_COMPONENTS[page], `${page} draws ${PAGE_COMPONENTS[page]}`)
  }
})

test('the usage card opens UsagePage focused on the Bot it names', () => {
  const release = card.setSettingsPages({ PAGE_ICONS: settings.PAGE_ICONS, PageBoundary: settings.PageBoundary, SettingsPage: settings.SettingsPage })
  try {
    states = [true, '']
    const target = card.settingsTarget({ page: 'usage', bot: 'Writer' }, roster)
    assert.equal(target.id, 'owner:b2', 'the usage route names the Bot as its owner')
    const tree = card.SettingsCard({ target, roster, actions: { openSettings() {} } })
    const [page] = walk(tree, node => node.type === settings.SettingsPage)
    assert.equal(page.props.shown, 'usage')
    const [usage] = walk(settings.SettingsPage(page.props), node => typeof node.type === 'function' && node.type.name === 'UsagePage')
    assert.ok(usage, 'the card body is UsagePage, not the empty Fragment')
    assert.equal(usage.props.focusId, 'owner:b2')
  } finally {
    release()
  }
})

test('open without the pages registered, or on a page this window lacks, it says so', () => {
  states = [true, '']
  const missing = card.SettingsCard({ target: card.settingsTarget({ page: 'plugin:gone' }, roster), roster, actions: {} })
  assert.match(textOf(missing), /This page is not in this window's Settings\./)
  assert.equal(walk(missing, node => node.type === 'button' && textOf(node) === 'Open in Settings').length, 0, 'no opener, no button')
})

// --- propose_bot_change -------------------------------------------------------------------
// Values made in the bundle's own realm compare by their JSON.
const plain = value => JSON.parse(JSON.stringify(value))
const line = proposal => `Proposed for Writer: role. The card is on screen; nothing changes until the user presses Apply.\nproposal: ${JSON.stringify(proposal)}`

test('a proposal is read from the result\'s last line, with only the fields a Bot may propose', () => {
  assert.deepEqual(plain(card.parseProposal(line({ bot: 'b2', note: 'n', change: { role: 'Editor', denyTools: 'bash', private: 'false', model: 'a/b' } }))),
    { bot: 'b2', note: 'n', change: { role: 'Editor', model: 'a/b' } })
  for (const text of ['No Bot named x.', line({ bot: 'b2', change: {} }), line({ change: { role: 'x' } }), 'proposal: {not json', line({ bot: 'b2', change: { denyTools: 'bash' } })]) {
    assert.equal(card.parseProposal(text), undefined, text)
  }
})

test('Apply saves a new model and its level alone, first, then the rest', () => {
  assert.deepEqual(plain(card.applySteps({ role: 'Editor', model: 'p/m', effort: 'high', name: 'Ed' })), [{ model: 'p/m', effort: 'high' }, { role: 'Editor', name: 'Ed' }])
  assert.deepEqual(plain(card.applySteps({ effort: 'low', role: 'x' })), [{ effort: 'low', role: 'x' }], 'a level alone stays with the rest')
  assert.deepEqual(plain(card.applySteps({ model: 'p/m' })), [{ model: 'p/m' }])
})

const editor = { ...writer, role: 'Wr', instructions: 'Write.', workDir: '', model: 'p/old', effort: 'high' }
const rosterOf = bot => ({ ...roster, byId: { b2: bot }, bots: [bot] })

test('the card shows each field as it is and as it would be, with Apply', () => {
  states = ['open', '']
  const proposal = { bot: 'b2', note: 'As you asked', change: { role: 'Editor', effort: '', workDir: '' } }
  const tree = card.ProposalCard({ proposal, roster: rosterOf(editor), actions: { updateBot() {}, openSettings() {} } })
  const rows = walk(tree, node => node.props?.className === 'bt-propcard-row').map(row => walk(row, node => node.props?.role === 'cell').map(textOf))
  assert.deepEqual(rows, [['Wr', 'Editor'], ['high', 'Model default'], ['Team workspace', 'Team workspace']])
  assert.match(textOf(tree), /As you asked/)
  assert.equal(walk(tree, node => node.type === 'button' && textOf(node) === 'Apply').length, 1)
})

test('Apply is the user\'s own save, in the steps applySteps gives, with the default level as null', async () => {
  states = ['open', '']
  const saved = []
  const proposal = { bot: 'b2', change: { role: 'Editor', model: 'p/new', effort: '' } }
  const tree = card.ProposalCard({ proposal, roster: rosterOf(editor), actions: { updateBot: async (id, patch) => { saved.push([id, patch]) } } })
  const [apply] = walk(tree, node => node.type === 'button' && textOf(node) === 'Apply')
  await apply.props.onClick()
  assert.deepEqual(plain(saved), [['b2', { model: 'p/new', effort: null }], ['b2', { role: 'Editor' }]])
})

test('once the Bot holds every proposed value the card settles as applied, with no buttons', () => {
  states = ['open', '']
  const proposal = { bot: 'b2', change: { role: 'Editor' } }
  const tree = card.ProposalCard({ proposal, roster: rosterOf({ ...editor, role: 'Editor' }), actions: { updateBot() {} } })
  assert.match(textOf(tree), /Applied/)
  assert.equal(walk(tree, node => node.type === 'button').length, 0)
})

test('a refused or unfinished call draws no proposal; a Bot gone from the team says so', () => {
  const actions = { updateBot() {} }
  for (const props of [{ done: false, content: '' }, { done: true, isError: true, content: line({ bot: 'b2', change: { role: 'x' } }) }, { done: true, content: 'Nothing to propose: Writer already has these settings.' }]) {
    assert.equal(walk(card.ProposalCall({ roster, actions, ...props }), node => node.type === card.ProposalCard).length, 0)
  }
  states = ['open', '']
  assert.match(textOf(card.ProposalCard({ proposal: { bot: 'gone', change: { role: 'x' } }, roster, actions })), /no longer on the team/)
})
