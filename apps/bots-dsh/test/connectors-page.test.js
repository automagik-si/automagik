import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { CATALOG } from '../src/host/connectors/catalog.js'
import { genieLampCream, genieLampInk, lamp, omniExpressions, omniMarkCream32, omniMarkInk32, triskleThreeColours32 } from '../src/client/art/inline.js'
import { OFFICIAL_APPS } from '../src/host/connectors/official.js'

// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

// The mailbox catalog row, bundled once and rendered with a minimal React stand-in whose
// useState survives re-renders: hooks are numbered by expansion order, which is
// stable because the tree expands the same way every pass.
const { outputFiles } = await build({
  stdin: {
    contents: "export { MailCatalogRow, MailToolCell } from './src/client/connectors.js'\nexport { ConnectorsPage } from './src/client/connectors-page.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const slots = []
let idx = 0
let concrete = null
let props = {}
const expand = (node) => {
  if (node === null || node === undefined || node === false || node === true) return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...(node.props ?? {}), children: expand(node.props?.children) } }
}
let active = () => expand(MailCatalogRow(props))
const rerender = () => { idx = 0; concrete = active() }
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, p, ...children) => ({ type, props: { ...(p ?? {}), children } }),
  Fragment: 'fragment',
  useEffect() {}, useLayoutEffect() {},
  useState: (init) => {
    const i = idx++
    if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
    return [slots[i], (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; rerender() }]
  },
  useMemo: make => make(),
  useRef: (current) => {
    const i = idx++
    if (!(i in slots)) slots[i] = { current }
    return slots[i]
  },
  useId: () => 'id',
}
const opened = []
const clipboard = { writeText: () => Promise.resolve() }
const dom = new JSDOM('<!doctype html><body></body>')
const module = { exports: {} }
// The page reads the ?mock-apps flag from window.location; the tests set it on the vm's window.
const pageWindow = { matchMedia: () => ({ matches: false }), dshDesktop: {}, open: (url) => { opened.push(url); return null } }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  document: dom.window.document,
  navigator: { clipboard },
  window: pageWindow,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { MailCatalogRow, MailToolCell, ConnectorsPage } = module.exports
const render = () => { active = () => expand(MailCatalogRow(props)); rerender() }
const renderCell = (cellProps) => { slots.length = 0; active = () => expand(MailToolCell(cellProps)); rerender() }

const renderPage = (pageProps) => { active = () => expand(ConnectorsPage(pageProps)); rerender() }

const flatten = (node, out = []) => {
  if (node === null || node === undefined || node === false || node === true) return out
  if (Array.isArray(node)) { node.forEach(n => flatten(n, out)); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  flatten(node.props?.children, out)
  return out
}
const collect = (match, out = []) => {
  const walk = (node) => {
    if (node === null || node === undefined || node === false || node === true) return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node !== 'object') return
    if (match(node)) out.push(node)
    walk(node.props?.children)
  }
  walk(concrete)
  return out
}
const click = (text) => {
  const button = collect(n => n.type === 'button' && flatten(n).join('') === text)[0]
  assert.ok(button, `button "${text}"`)
  button.props.onClick?.()
}
const fill = (label, value) => {
  const input = collect(n => n.type === 'input' && n.props?.['aria-label'] === label)[0]
  assert.ok(input, `input "${label}"`)
  input.props.onChange?.({ target: { value } })
}
const addressAt = domain => ['me', domain].join('@')
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

test('the mail form shows the QQ guide with its links and closes after a good add', async () => {
  const adds = []
  const actions = {
    mailAccountAdd: (body) => { adds.push(body); return Promise.resolve({ accounts: [] }) },
    mailAccountRemove: () => Promise.resolve(true),
  }
  props = { mail: { accounts: [] }, actions }
  slots.length = 0
  render()
  click('Connect')
  click('QQ')
  const guide = collect(n => n.props?.className === 'bt-mail-guide')[0]
  assert.ok(guide, 'guide list')
  assert.equal(collect(n => n.type === 'li').length, 3)
  const links = collect(n => n.type === 'button' && n.props?.className === 'bt-connector-link')
  assert.equal(links.length, 2)
  opened.length = 0
  links.forEach(link => link.props.onClick())
  assert.equal(opened[0], 'https://mail.qq.com')
  assert.match(opened[1], /help\.mail\.qq\.com/)
  fill('Email address', addressAt('qq.com'))
  fill('Authorization code', 'CODE')
  click('Add')
  await flush()
  assert.equal(adds.length, 1)
  assert.equal(adds[0].provider, 'qq')
  assert.equal(collect(n => String(n.props?.className ?? '').includes('bt-mail-form')).length, 0, 'form closed after a resolved add')
})

test('a busy mail add blocks a second click and a good add clears the fields', async () => {
  const adds = []
  let release = null
  const actions = {
    mailAccountAdd: (body) => { adds.push(body); return new Promise(resolve => { release = resolve }) },
    mailAccountRemove: () => Promise.resolve(true),
  }
  props = { mail: { accounts: [] }, actions }
  slots.length = 0
  render()
  click('Connect')
  fill('Email address', addressAt('qq.com'))
  fill('Authorization code', 'CODE')
  click('Add')
  await flush()
  assert.equal(adds.length, 1)
  const adding = collect(n => n.type === 'button' && flatten(n).join('') === 'Verifying…')[0]
  assert.ok(adding, 'busy button reads Verifying…')
  assert.equal(adding.props.disabled, true)
  adding.props.onClick?.()
  await flush()
  assert.equal(adds.length, 1, 'a second click while busy adds nothing')
  const address = collect(n => n.type === 'input' && n.props?.['aria-label'] === 'Email address')[0]
  assert.equal(address.props.disabled, true, 'the fields are disabled while busy')
  release({ accounts: [] })
  await flush()
  assert.equal(collect(n => String(n.props?.className ?? '').includes('bt-mail-form')).length, 0, 'form closed after a resolved add')
  // The closed form unmounted; the stand-in keeps hook slots by index, so start them over.
  slots.length = 0
  render()
  click('Connect')
  assert.equal(collect(n => n.type === 'input' && n.props?.['aria-label'] === 'Email address')[0].props.value, '', 'address cleared')
  assert.equal(collect(n => n.type === 'input' && String(n.props?.className ?? '') === 'bt-secret-input')[0].props.value, '', 'code cleared')
  const qq = collect(n => n.type === 'button' && flatten(n).join('') === 'QQ')[0]
  assert.equal(qq.props['aria-pressed'], true, 'provider back to the default')
  click('Other')
  assert.equal(collect(n => n.type === 'input' && n.props?.['aria-label'] === 'IMAP host')[0].props.value, '', 'IMAP host cleared')
  assert.equal(collect(n => n.type === 'input' && n.props?.['aria-label'] === 'SMTP host')[0].props.value, '', 'SMTP host cleared')
})

test('the mail send card is an editable show_view form card with the approval rule menu', async () => {
  const bot = { id: 'b1', name: 'Chief' }
  const sender = addressAt('qq.com')
  const body = 'Hi **all**\n<!-- hidden --> [link](https://x.test)\n\nBye'
  const roster = {
    byId: { s1: bot },
    connectors: { mail: { accounts: [{ id: sender, address: sender }] } },
    mailRequests: {
      b1: [{ id: 'r1', callId: 'c1', sessionId: 's1', status: 'pending', account: sender, to: 'team@corp.dev', subject: 'Weekly_1', body, attachmentDetails: [{ name: 'report.pdf', size: 2048 }] }],
    },
  }
  const answers = []
  const ruleSets = []
  let opened = false
  renderCell({
    sessionId: 's1', callId: 'c1', roster,
    actions: {
      mailSendAnswer: (...args) => { answers.push(args); return Promise.resolve() },
      mailRuleSet: (payload) => { ruleSets.push(payload); return Promise.resolve() },
      openConnectors: () => { opened = true },
    },
  })
  const card = collect(n => String(n.props?.className ?? '').split(' ').includes('dv-view'))[0]
  assert.ok(card, 'view card root')
  assert.ok(card.props.className.split(' ').includes('dv-q'), 'framed like the show_view answer cards')
  assert.equal( flatten(collect(n => n.props?.className === 'dv-view-title')[0]).join(''), 'Mail')
  assert.ok(collect(n => n.props?.className === 'dv-view-icon')[0], 'mail icon in header')
  // Prefilled fields: subject, readOnly from, editable to, editable cc, multiline body.
  const subjectInput = collect(n => n.type === 'input' && n.props?.['aria-label'] === 'Subject')[0]
  const fromInput = collect(n => n.type === 'input' && n.props?.['aria-label'] === 'From')[0]
  const toInput = collect(n => n.type === 'input' && n.props?.['aria-label'] === 'To')[0]
  const ccInput = collect(n => n.type === 'input' && n.props?.['aria-label'] === 'Cc')[0]
  const bodyArea = collect(n => n.type === 'textarea' && n.props?.['aria-label'] === 'Write a message…')[0]
  assert.equal(subjectInput.props.value, 'Weekly_1')
  assert.equal(fromInput.props.value, sender)
  assert.equal(fromInput.props.readOnly, true)
  assert.equal(toInput.props.value, 'team@corp.dev')
  assert.equal(ccInput.props.value, '')
  assert.equal(bodyArea.props.value, body, 'body stays literal in textarea')
  const texts = collect(n => typeof n.props?.text === 'string' && n.props?.variant === 'compact').map(n => n.props.text)
  assert.ok(texts.some(text => text.includes('report\\.pdf \\(2 KB\\)')), 'attachments')
  // Approval menu defaults to Needs approval.
  const ruleBtn = collect(n => n.type === 'button' && n.props?.className === 'bt-mail-rule-btn')[0]
  assert.equal(flatten(ruleBtn).join(''), 'Needs approval')
  ruleBtn.props.onClick()
  click('Allow recipient')
  await flush()
  assert.equal(ruleSets.length, 1)
  assert.equal(ruleSets[0].mode, 'allow-recipient')
  assert.equal(flatten(collect(n => n.type === 'button' && n.props?.className === 'bt-mail-rule-btn')[0]).join(''), 'Allow recipient')
  // Manage rules opens Connectors settings.
  collect(n => n.type === 'button' && n.props?.className === 'bt-mail-rule-btn')[0].props.onClick()
  click('Manage rules')
  assert.equal(opened, true)
  // Edit recipient and body in the card, then press Send.
  toInput.props.onChange({ target: { value: 'edited@corp.dev' } })
  collect(n => n.type === 'textarea' && n.props?.['aria-label'] === 'Write a message…')[0].props.onChange({ target: { value: 'Edited body' } })
  const send = collect(n => n.type === 'button' && n.props?.className === 'dv-q-submit')[0]
  assert.equal(flatten(send).join(''), 'Send')
  assert.equal(flatten(collect(n => n.type === 'button' && n.props?.className === 'dv-q-btn')[0]).join(''), 'Discard')
  const formNode = collect(n => n.type === 'form' && n.props?.className === 'dv-widget-form')[0]
  formNode.props.onSubmit({ preventDefault() {} })
  await flush()
  assert.equal(answers.length, 1)
  assert.equal(answers[0][0], 'r1')
  assert.equal(answers[0][1], 'send')
  assert.equal(answers[0][2].rule, 'allow-recipient')
  assert.equal(answers[0][2].fields.to, 'edited@corp.dev')
  assert.equal(answers[0][2].fields.body, 'Edited body')
})

test('a failed mail add shows the host message inside the form', async () => {
  const actions = {
    mailAccountAdd: () => Promise.reject(new Error('The password was refused. Use the mailbox app password or authorization code, not the account password.')),
    mailAccountRemove: () => Promise.resolve(true),
  }
  props = { mail: { accounts: [] }, actions }
  slots.length = 0
  render()
  click('Connect')
  fill('Email address', addressAt('qq.com'))
  fill('Authorization code', 'WRONG')
  click('Add')
  await flush()
  const alert = collect(n => n.props?.role === 'alert')[0]
  assert.ok(alert, 'inline error')
  assert.match(flatten(alert).join(''), /password was refused/)
  assert.ok(String(collect(n => String(n.props?.className ?? '').includes('bt-mail-form'))[0]?.props?.className ?? '').includes('bt-mail-form'), 'form stays open')
})

// The rows the host sends (`pending` is the row built in connectors/index.js).
const githubAuth = { kind: 'oauth', client: { id: 'client' }, token: true }
const github = extra => ({ id: 'github', name: 'GitHub', category: 'dev', auth: githubAuth, state: 'off', ...extra })
const devicePending = userCode => ({ state: 'connecting', pending: { kind: 'device', userCode, verificationUri: 'https://github.com/login/device', expiresAt: 4102444800000 } })
const pageWith = (app, actions = {}) => ({ roster: { connectors: { connectors: [app], mail: { accounts: [] } } }, actions })
const has = className => collect(n => String(n.props?.className ?? '').split(' ').includes(className))
const pageText = () => flatten(concrete).join(' ')
const sectionOf = (node) => {
  for (const section of collect(n => n.type === 'section')) {
    const inside = []
    const walk = (n) => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') { inside.push(n); walk(n.props?.children) } }
    walk(section)
    if (inside.includes(node)) return flatten(collect(n => n === section)[0].props.children[0]).join('')
  }
  return null
}
const sectionButton = (section, text) => collect(n => n.type === 'button' && flatten(n).join('') === text).find(n => sectionOf(n) === section)

test('a device sign-in shows its code on the clicked tile and says copied only once the write worked', async () => {
  slots.length = 0
  opened.length = 0
  let finishCopy = null
  const written = []
  clipboard.writeText = (text) => { written.push(text); return new Promise((resolve) => { finishCopy = resolve }) }
  const pending = github(devicePending('WDJB-MJHT'))
  const actions = { connectorConnect: () => Promise.resolve({ connectors: [pending] }) }
  const page = pageWith(github(), actions)
  renderPage(page)
  sectionButton('Developer', 'Connect').props.onClick()
  // The host's update reaches the page while the clipboard write is still running.
  page.roster = pageWith(pending).roster
  await flush()
  rerender()
  assert.deepEqual(written, ['WDJB-MJHT'])
  assert.deepEqual(opened, [], 'the page waits for the clipboard: it takes the focus as it opens')
  assert.equal(has('bt-connector-code').length, 1, 'one tile draws the code')
  assert.equal(flatten(has('bt-connector-code')[0]).join(''), 'WDJB-MJHT')
  assert.equal(sectionOf(has('bt-connector-code')[0]), 'Developer', 'on the tile that was clicked')
  assert.match(pageText(), /github\.com\/login\/device/)
  assert.doesNotMatch(pageText(), /Copied to clipboard/)
  finishCopy()
  await flush()
  rerender()
  assert.match(pageText(), /Copied to clipboard/)
  assert.deepEqual(opened.slice(-1), ['https://github.com/login/device'])
})

test('a refused clipboard write shows no copied hint and the Copy button can still do it', async () => {
  slots.length = 0
  clipboard.writeText = () => Promise.reject(new Error('Document is not focused'))
  const pending = github(devicePending('REFU-SED1'))
  const page = pageWith(github(), { connectorConnect: () => Promise.resolve({ connectors: [pending] }) })
  renderPage(page)
  sectionButton('Developer', 'Connect').props.onClick()
  await flush()
  page.roster = pageWith(pending).roster
  await flush()
  rerender()
  assert.equal(flatten(has('bt-connector-code')[0]).join(''), 'REFU-SED1')
  assert.doesNotMatch(pageText(), /Copied to clipboard/)
  clipboard.writeText = () => Promise.resolve()
  click('Copy')
  await flush()
  rerender()
  assert.match(pageText(), /Copied to clipboard/)
})

test('a sign-in found after a reload is drawn once, and a browser sign-in says where to finish', () => {
  slots.length = 0
  renderPage(pageWith(github(devicePending('RELO-ADED'))))
  assert.equal(has('bt-connector-code').length, 1)
  assert.equal(sectionOf(has('bt-connector-code')[0]), 'Developer')
  slots.length = 0
  renderPage(pageWith(github({ state: 'connecting', pending: { kind: 'browser', url: 'https://github.com/login/oauth' } })))
  assert.equal(pageText().split('Finish signing in in your browser.').length - 1, 1)
})

// --- the real Apps page: the Automagik overlay on top of upstream ----------
// The official rows come from official.js, the upstream rows from catalog.js as the host sends
// them, and the states and actions are what the page already knows.
const UPSTREAM = CATALOG.filter(entry => entry.id !== 'mail').map(entry => ({
  id: entry.id, name: entry.name, category: entry.category, about: entry.about, auth: entry.auth, state: 'off',
}))
const CATEGORY_LABEL = { dev: 'Developer', docs: 'Docs & files', work: 'Work', design: 'Design', data: 'Data', commerce: 'Commerce', search: 'Search' }
const officialPage = ({ bots = [], models = [], mainBotId = bots[0]?.id ?? null, connectors = UPSTREAM, actions = {} } = {}) => ({
  roster: {
    ready: true, bots, byId: Object.fromEntries(bots.map(bot => [bot.id, bot])),
    mainBotId, mainBotIds: mainBotId === null ? [] : [mainBotId], models,
    connectors: { connectors, mail: { accounts: [] } },
  },
  actions,
})
const within = (root, match) => {
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (match(node)) out.push(node)
    walk(node.props?.children)
  }
  walk(root)
  return out
}
const officialTile = name => collect(n => n.props?.className === 'bt-app' && flatten(n).join('').startsWith(name))[0]
const actionIn = (tile, label) => within(tile, n => n.type === 'button' && flatten(n).join('') === label)[0]
const mainButton = name => collect(n => n.type === 'button' && n.props?.className === 'bt-app-main' && flatten(n).join('').startsWith(name))[0]

test('the Automagik overlay comes first and only its rows carry the Official tag', () => {
  slots.length = 0
  renderPage(officialPage())
  const titles = collect(n => n.type === 'h3').map(n => flatten(n).join(''))
  assert.equal(titles[0], 'Automagik official')
  const names = collect(n => n.props?.className === 'bt-app-name').map(n => (Array.isArray(n.props.children) ? n.props.children[0] : n.props.children))
  assert.deepEqual(names.slice(0, OFFICIAL_APPS.length), OFFICIAL_APPS.map(app => app.name))
  for (const app of OFFICIAL_APPS) {
    const tile = officialTile(app.name)
    assert.ok(tile, app.name)
    assert.match(flatten(tile).join(' '), /Official/, `${app.name} carries the tag`)
  }
  assert.doesNotMatch(flatten(officialTile('GitHub')).join(' '), /Official/)
  assert.equal((pageText().match(/Official/g) ?? []).length, OFFICIAL_APPS.length, 'one tag per official row, none upstream')
})

test('the upstream categories render from catalog.js, after the overlay', () => {
  slots.length = 0
  renderPage(officialPage())
  const titles = collect(n => n.type === 'h3').map(n => flatten(n).join(''))
  assert.deepEqual(titles, ['Automagik official', ...Object.values(CATEGORY_LABEL)])
  for (const [id, label] of Object.entries(CATEGORY_LABEL)) {
    const entries = CATALOG.filter(row => row.id !== 'mail' && row.category === id)
    // Work's preview starts with the mailbox, so one fewer catalog row fits there.
    for (const entry of entries.slice(0, id === 'work' ? 5 : 6)) {
      const tile = officialTile(entry.name)
      assert.ok(tile, `${entry.name} is drawn from the catalog`)
      assert.ok(sectionOf(tile).startsWith(label), `${entry.name} stays in its own category`)
    }
    if (entries.length > 6) assert.ok(collect(n => n.type === 'button' && flatten(n).join('') === 'See all')[0], `${label} offers the rest`)
  }
  // Each section's preview hides its last rows; See all shows them from the same catalog.
  const seeAllIn = label => collect(n => n.type === 'button' && flatten(n).join('') === 'See all').find(n => sectionOf(n).startsWith(label))
  seeAllIn('Work').props.onClick()
  for (const entry of CATALOG.filter(row => row.category === 'work')) assert.ok(officialTile(entry.name), `${entry.name} comes with the rest of Work`)
})

test('a Bot on the roster is Installed and a kind with no Bot is not installed', () => {
  slots.length = 0
  renderPage(officialPage({ bots: [{ id: 'omni-1', kind: 'omni', name: 'Omni' }], actions: { openHarnessOnboarding: () => {} } }))
  assert.match(flatten(officialTile('Omni')).join(' '), /Installed/)
  assert.match(flatten(officialTile('Genie')).join(' '), /Not installed/)
  assert.ok(actionIn(officialTile('Genie'), 'Install'), 'a missing Genie offers the team-step install')
  for (const name of ['Claude', 'Codex']) {
    const tile = officialTile(name)
    assert.match(flatten(tile).join(' '), /Not installed/)
    assert.equal(actionIn(tile, 'Install'), undefined, `${name} has no install flow here`)
  }
})

test('an install opens the team setup, and an installed Bot opens its chat', () => {
  const calls = []
  const actions = {
    closeSettings: () => calls.push(['closeSettings']),
    openSession: id => calls.push(['openSession', id]),
    openHarnessOnboarding: id => calls.push(['openHarnessOnboarding', id]),
  }
  slots.length = 0
  renderPage(officialPage({ bots: [{ id: 'omni-1', kind: 'omni', name: 'Omni' }], actions }))
  actionIn(officialTile('Omni'), 'Installed').props.onClick()
  actionIn(officialTile('Genie'), 'Install').props.onClick()
  assert.deepEqual(calls, [['closeSettings'], ['openSession', 'omni-1'], ['closeSettings'], ['openHarnessOnboarding', 'omni-team']])
})

test('Claude and Codex follow the ACP routes, open the sign-in the app already uses, and offer no install', () => {
  const calls = []
  const actions = {
    closeSettings: () => calls.push(['closeSettings']),
    openCliLogin: (botId, provider) => calls.push(['openCliLogin', botId, provider]),
  }
  const models = [
    { ref: 'acp-claude/sonnet', provider: 'acp-claude', needsSignIn: true },
    { ref: 'acp-codex/gpt-5', provider: 'acp-codex' },
  ]
  slots.length = 0
  renderPage(officialPage({ bots: [{ id: 'main', kind: 'omni', name: 'Omni' }], mainBotId: 'main', models, actions }))
  assert.match(flatten(officialTile('Claude')).join(' '), /Sign-in needed/)
  assert.match(flatten(officialTile('Codex')).join(' '), /Installed/)
  actionIn(officialTile('Claude'), 'Sign in').props.onClick()
  actionIn(officialTile('Codex'), 'Installed').props.onClick()
  assert.deepEqual(calls, [
    ['closeSettings'], ['openCliLogin', 'main', 'acp-claude'],
    ['closeSettings'], ['openCliLogin', 'main', 'acp-codex'],
  ])
})

test('the expanded official row keeps what the app is, its state and its one action', () => {
  slots.length = 0
  renderPage(officialPage({ bots: [{ id: 'main', kind: 'omni', name: 'Omni' }], models: [] }))
  mainButton('Claude').props.onClick()
  const detail = has('bt-app-expanded')[0]
  assert.ok(detail, 'the row expands')
  const text = flatten(detail).join(' ')
  assert.match(text, /Claude/)
  assert.match(text, /Claude Code through the Agent Client Protocol/)
  assert.match(text, /Not installed/)
  assert.equal(within(detail, n => n.type === 'button').length, 0, 'a missing agent has no action')
})

test('the Omni and Genie rows wear their own brand mark, ink or cream, at 32px', () => {
  const markIn = name => within(officialTile(name), n => n.type === 'img' && n.props?.className === 'bt-official-brand-mark')[0]
  const pin = (name, expected, forbidden) => {
    const mark = markIn(name)
    assert.ok(mark, `${name} draws its own mark`)
    assert.equal(mark.props.src, expected, `${name} draws the brand's own drawing`)
    assert.deepEqual([mark.props.width, mark.props.height], [32, 32], `${name}'s mark is drawn at 32px`)
    for (const other of forbidden) assert.notEqual(mark.props.src, other, `${name} never falls back to the triskle or the pet`)
  }
  slots.length = 0
  renderPage(officialPage({ bots: [], models: [] }))
  pin('Omni', omniMarkInk32, [triskleThreeColours32, omniExpressions, lamp])
  pin('Genie', genieLampInk, [triskleThreeColours32, omniExpressions, lamp])
  // The mark follows DSH's Appearance setting while the page is open.
  dom.window.document.body.setAttribute('data-ds-dark-theme', '')
  try {
    slots.length = 0
    renderPage(officialPage({ bots: [], models: [] }))
    pin('Omni', omniMarkCream32, [omniMarkInk32, triskleThreeColours32, omniExpressions, lamp])
    pin('Genie', genieLampCream, [genieLampInk, triskleThreeColours32, omniExpressions, lamp])
  } finally {
    dom.window.document.body.removeAttribute('data-ds-dark-theme')
  }
  // The expanded row wears the same mark, in the same colour, not the ACP agents' look.
  slots.length = 0
  renderPage(officialPage({ bots: [], models: [] }))
  mainButton('Genie').props.onClick()
  const detail = has('bt-app-expanded')[0]
  const inDetail = within(detail, n => n.type === 'img' && n.props?.className === 'bt-official-brand-mark')[0]
  assert.equal(inDetail.props.src, genieLampInk, 'the expanded Genie row draws the lamp')
  assert.deepEqual([inDetail.props.width, inDetail.props.height], [32, 32], 'the expanded row does not shrink the mark')
})

// --- the ?mock-apps preview ----------------------------------------------
// The preview is a clickable mock of the page: sample rows, a SAMPLE DATA banner, no roster
// read and no host action. The flag alone selects it; every other query value is the real page.
const withFlag = (value, run) => {
  pageWindow.location = { search: value }
  try { return run() } finally { delete pageWindow.location }
}
const expandedRows = () => collect(n => n.type === 'button' && n.props?.className === 'bt-app-main' && n.props?.['aria-expanded'] === true).map(n => flatten(n)[0])

test('?mock-apps alone selects the sample preview, and its rows open in place', () => {
  slots.length = 0
  withFlag('?mock-apps', () => {
    const actions = new Proxy({}, { get: () => () => { throw new Error('the mock calls no host action') } })
    const roster = {
      ready: true,
      connectors: { connectors: [{ id: 'roster-only', name: 'Roster Only', category: 'dev', state: 'off' }], mail: { accounts: [] } },
    }
    renderPage({ roster, actions })
    assert.match(pageText(), /SAMPLE DATA/)
    assert.match(pageText(), /A mock of the Apps page\. Nothing here installs; click a row to expand it\./)
    assert.match(pageText(), /Sample row: nothing is installed from this preview\./)
    assert.doesNotMatch(pageText(), /Roster Only/, 'the mock reads no catalog')
    const titles = collect(n => n.type === 'h3').map(n => flatten(n).join(''))
    assert.equal(titles[0], 'Automagik official')
    for (const name of ['Omni', 'Genie', 'Claude', 'Codex', 'GitHub', 'Notion']) assert.ok(pageText().includes(name), name)
    assert.deepEqual(expandedRows(), ['Genie'], 'one sample row starts open')
    mainButton('Claude').props.onClick()
    assert.deepEqual(expandedRows(), ['Claude'], 'a click opens that row only')
    assert.equal((pageText().match(/Sample row: nothing is installed from this preview\./g) ?? []).length, 1, 'one sample row open at a time')
    click('Install')
    assert.deepEqual(expandedRows(), ['Genie'], 'a sample control opens its own row and calls no host action')
  })
})

test('the real page has no sample marker without the flag', () => {
  const page = officialPage({ bots: [{ id: 'main', kind: 'omni', name: 'Omni' }], models: [] })
  slots.length = 0
  renderPage(page)
  const without = pageText()
  assert.match(without, /Automagik official/)
  assert.match(without, /Not installed/)
  assert.doesNotMatch(without, /SAMPLE DATA|A mock of the Apps page|Sample row:/)
  for (const search of ['', '?', '?foo=1', '?mock=apps', '?mock-apps-other=1', '?not-mock-apps=1']) {
    slots.length = 0
    withFlag(search, () => renderPage(page))
    assert.equal(pageText(), without, `"${search}" shows the real page`)
  }
})

test('an unrelated query value is the real page, not the preview', () => {
  const page = officialPage({ bots: [{ id: 'main', kind: 'omni', name: 'Omni' }], models: [] })
  slots.length = 0
  withFlag('?settings=apps', () => renderPage(page))
  assert.match(pageText(), /Automagik official/)
  assert.match(pageText(), /Not installed/)
  assert.doesNotMatch(pageText(), /SAMPLE DATA/)
})
