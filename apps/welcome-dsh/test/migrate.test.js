// The "From another tool" step as the page draws it: Hermes moves, OpenClaw/Grok bot/Muse are
// honest labels, the confirm says what will happen, the key is never in the DOM, and a hand-off
// defers to Omni's own Telegram guide instead of rebuilding it. The view is pure, so every state
// is rendered here from fixtures (the screenshot harness renders the same view).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// A fixture key, assembled here so no secret-shaped literal sits in the tree.
const FIXTURE_KEY = ['123456789', `${'A'.repeat(20)}${'B'.repeat(15)}`].join(':')
const BOT = 'b0b0b0b0-2222-4333-8444-555555555555'
const OTHER = 'c0c0c0c0-3333-4444-8555-666666666666'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/migrate.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@automagik/bots-dsh/client'],
  loader: { '.css': 'text' },
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {}, useRef: current => ({ current }), useCallback: fn => fn,
  useMemo: fn => fn(), useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
}
const client = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module: client, exports: client.exports, URL, setTimeout, clearTimeout,
  document: { body: null, getElementById: () => null },
  require: name => ({ react, 'react-dom': { createPortal: node => node }, '@automagik/bots-dsh/client': {} })[name],
})
const migrate = client.exports
// Values made inside the vm compare by shape, not by realm.
const plain = value => JSON.parse(JSON.stringify(value))

function render(node) {
  if (Array.isArray(node)) return node.map(render)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }))
  return { ...node, children: node.children.map(render) }
}
function findAll(node, match, out = []) {
  if (Array.isArray(node)) node.forEach(child => findAll(child, match, out))
  else if (node && typeof node === 'object') {
    if (match(node)) out.push(node)
    node.children.forEach(child => findAll(child, match, out))
  }
  return out
}
const textOf = node => (Array.isArray(node) ? node.map(textOf).join('') : node && typeof node === 'object' ? textOf(node.children) : node === null || node === undefined || node === false ? '' : String(node))
const byClass = name => node => String(node?.props?.className ?? '').split(' ').includes(name)
const buttons = tree => findAll(tree, node => node.type === 'button')
const buttonLabels = tree => buttons(tree).map(node => textOf(node))

const probe = (overrides = {}) => ({
  hermes: { found: true, where: 'local', channel: 'on', key: 'available', gatewayRunning: true, pendingRestart: false, ...overrides.hermes },
  omni: {
    linked: true, attach: true, telegram: null,
    bots: [{ id: BOT, name: 'Omni', main: true }, { id: OTHER, name: 'Harbor', main: false }],
    ...overrides.omni,
  },
})

function view(props = {}) {
  return render(migrate.MigrateView({ ...props }))
}

test('Hermes moves; OpenClaw, Grok bot and Muse are labels with a Coming soon pill, never buttons', () => {
  const tree = view({ phase: 'choosing' })
  const cards = findAll(tree, byClass('oai-mig-tool'))
  assert.equal(cards.length, 4)
  const ready = cards.filter(card => card.type === 'button')
  assert.equal(ready.length, 1)
  assert.match(textOf(ready[0]), /Hermes/)
  assert.match(textOf(ready[0]), /Move it/)
  assert.deepEqual(plain(migrate.TOOLS.map(tool => tool.name)), ['Hermes', 'OpenClaw', 'Grok bot', 'Muse'])

  const soon = cards.filter(card => card.type === 'article')
  assert.equal(soon.length, 3)
  for (const card of soon) {
    assert.ok(findAll(card, byClass('oai-soon')).length === 1)
    assert.equal(findAll(card, node => node.type === 'button' || node.type === 'a').length, 0, 'a not-ready card has a dead control')
    assert.match(textOf(card), /Coming soon/)
  }
  assert.deepEqual(plain(soon.map(textOf).map(body => migrate.TOOLS.find(tool => body.includes(tool.name)).name)), ['OpenClaw', 'Grok bot', 'Muse'])
})

test('the confirm card says Hermes restarts, its settings are copied, and the order is Hermes then Omni', () => {
  const tree = view({ phase: 'confirm', probe: probe(), agreed: false })
  const body = textOf(tree)
  assert.match(body, /The wizard reads Hermes's bot key/)
  assert.match(body, /Hermes's Telegram is switched off/)
  assert.match(body, /keeps a copy of its settings first/)
  assert.match(body, /restarts for a few seconds/)
  assert.match(body, /other channels blink and come back by themselves/)
  assert.match(body, /Omni starts its Telegram channel with the same bot/)
  const order = ['reads Hermes', 'switched off', 'Omni starts']
  const at = order.map(part => body.indexOf(part))
  assert.deepEqual([...at].sort((a, b) => a - b), at)

  const agree = findAll(tree, node => node.type === 'input')[0]
  assert.equal(agree.props.type, 'checkbox')
  const primary = buttons(tree).find(node => String(node.props.className).includes('oai-primary'))
  assert.equal(primary.props.disabled, true)
  assert.equal(textOf(primary), 'Switch it over')

  const agreed = view({ phase: 'confirm', probe: probe(), agreed: true })
  assert.equal(buttons(agreed).find(node => String(node.props.className).includes('oai-primary')).props.disabled, false)
})

test('already off or waiting for a restart reads as it is, without claiming work it will not do', () => {
  const off = view({ phase: 'confirm', probe: probe({ hermes: { channel: 'off', pendingRestart: false } }) })
  assert.match(textOf(off), /Hermes · Telegram is already off/)
  assert.match(textOf(off), /nothing is switched\. No restart is needed/)
  assert.doesNotMatch(textOf(off), /keeps a copy of its settings first/)
  assert.equal(textOf(buttons(off).find(node => String(node.props.className).includes('oai-primary'))), 'Start Omni with it')

  const pending = view({ phase: 'confirm', probe: probe({ hermes: { channel: 'off', pendingRestart: true } }) })
  assert.match(textOf(pending), /Hermes still has to let go of the old channel/)
  assert.match(textOf(pending), /restarts for a few seconds/)
  assert.match(textOf(pending), /I am ready: Hermes restarts/)
})

test('the bot who answers is picked from the team, main first, and only where Omni can bind one', () => {
  const tree = view({ phase: 'confirm', probe: probe(), botId: BOT })
  const radios = findAll(tree, node => node.props.role === 'radio')
  assert.deepEqual(radios.map(textOf), ['OmniMain Bot', 'Harbor'])
  assert.match(String(radios[0].props.className), /is-on/)
  const picked = []
  const second = view({ phase: 'confirm', probe: probe(), botId: BOT, onPickBot: id => picked.push(id) })
  findAll(second, node => node.props.role === 'radio')[1].props.onClick()
  assert.deepEqual(picked, [OTHER])

  const noAttach = view({ phase: 'confirm', probe: probe({ omni: { attach: false } }) })
  assert.equal(findAll(noAttach, node => node.props.role === 'radio').length, 0)
  assert.equal(migrate.answerBots(probe({ omni: { attach: false } })).length, 0)
  assert.equal(migrate.defaultAnswerBot(probe()), BOT)
})

test('the move shows the key strip and its steps, and never a key', () => {
  const steps = ['key', 'hermes', 'omni', 'listen'].map((id, index) => ({ id, state: index === 0 ? 'now' : 'pending' }))
  const tree = view({ phase: 'moving', steps })
  const body = textOf(tree)
  assert.match(body, /The bot key passes straight from Hermes into Omni/)
  assert.match(body, /It never appears here, in a log or in a file/)
  for (const step of migrate.MOVE) assert.match(body, new RegExp(step.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(body, new RegExp(FIXTURE_KEY))
  assert.equal(findAll(tree, byClass('oai-mig-bead')).length, 4)
  assert.deepEqual(findAll(tree, node => node.type === 'li' && node.props['data-state'] !== undefined).map(node => node.props['data-state']), ['now', 'pending', 'pending', 'pending'])
})

test('done shows the bot, the say hi link, the live status and what happened to Hermes', () => {
  const result = { channelId: OTHER, channelName: 'Telegram', connected: true, botName: '@HefestoBot', chatUrl: 'https://t.me/HefestoBot', attached: true, answering: true, answerBot: { id: BOT, name: 'Omni' }, hermesOff: true, hermesWasOff: false }
  const tree = view({ phase: 'done', result })
  assert.match(textOf(tree), /@HefestoBot/)
  assert.match(textOf(tree), /Listening on Telegram/)
  assert.match(textOf(tree), /Replies through Omni\./)
  assert.match(textOf(tree), /Hermes: Telegram off/)
  const link = findAll(tree, node => node.type === 'a')[0]
  assert.equal(link.props.href, 'https://t.me/HefestoBot')
  assert.match(textOf(link), /Say hi to your bot/)

  const waiting = view({ phase: 'done', result: { ...result, connected: false, chatUrl: null }, onCheckStatus: () => {} })
  assert.match(textOf(waiting), /Waiting for Omni to say it is up/)
  assert.match(textOf(waiting), /Check status/)

  const wasOff = view({ phase: 'done', result: { ...result, hermesWasOff: true } })
  assert.match(textOf(wasOff), /Hermes: Telegram was already off/)
})

test('the one case where Omni leaves the Bot off explains it and opens that Bot\'s settings', () => {
  const result = { channelId: OTHER, channelName: 'Telegram', connected: true, botName: '@HefestoBot', chatUrl: null, attached: true, answering: false, answeringOff: true, answerBot: { id: BOT, name: 'Omni' }, hermesOff: true }
  const opened = []
  const tree = view({ phase: 'done', result, canOpenSettings: true, onOpenSettings: id => opened.push(id) })
  const body = textOf(tree)
  assert.match(body, /Omni added the bot, but your Bot Omni is off and already answers on other channels/)
  assert.match(body, /Turning it on here would turn those on too/)
  const button = buttons(tree).find(node => textOf(node).includes('Open Omni\'s settings'))
  assert.ok(button)
  button.props.onClick()
  assert.deepEqual(opened, [BOT])
})

test('a hand-off sends the person to Omni\'s own guide and does not rebuild it', () => {
  for (const [reason, title] of [['no-hermes', 'Hermes is not on this computer'], ['no-channel', 'No Hermes Telegram bot to move'], ['no-key', 'Hermes has no bot key this wizard can read'], ['no-omni', 'Connect Omni first'], ['manual', "Set Omni's Telegram up in Channels"]]) {
    const opened = []
    const tree = view({ phase: 'handoff', handoff: { reason }, onOpenChannels: () => opened.push(true) })
    assert.match(textOf(tree), new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    const labels = buttonLabels(tree)
    assert.ok(labels.includes('Open Omni\'s Channels'))
    assert.ok(labels.includes('Check again'))
    assert.ok(labels.includes('Not now'))
    buttons(tree).find(node => textOf(node) === 'Open Omni\'s Channels').props.onClick()
    assert.deepEqual(opened, [true])
    const body = textOf(tree)
    for (const guide of ['BotFather', 'Paste its token', 'Create the bot', 'Say hi']) assert.doesNotMatch(body, new RegExp(guide))
  }
  assert.equal(migrate.handoffOf(probe()), null)
  assert.equal(migrate.handoffOf(probe({ hermes: { key: 'missing' } })).reason, 'no-key')
  assert.equal(migrate.handoffOf(probe({ omni: { telegram: { id: OTHER, channelName: 'Telegram', connected: true } } })), null)
  assert.equal(migrate.canMove(probe()), true)
  assert.equal(migrate.canMove(probe({ hermes: { found: false } })), false)
})

test('a failure names what changed, offers the way out, and hides a key-shaped run', () => {
  const still = view({ phase: 'problem', error: { code: 'hermes-still-on', message: 'Hermes still has the channel.', changed: { hermesOff: false } } })
  assert.match(textOf(still), /Hermes still has the channel\. Nothing was handed to Omni, and its settings were put back\./)
  assert.deepEqual(buttonLabels(still), ['Set up Omni\'s Telegram instead', 'Try again'])

  const after = view({ phase: 'problem', error: { code: 'omni', message: `Omni did not take the bot key. Nothing was handed to it. ${FIXTURE_KEY}`, changed: { hermesOff: true, omniCreated: false } } })
  assert.match(textOf(after), /Hermes's Telegram is off and Omni did not take the bot/)
  assert.doesNotMatch(textOf(after), new RegExp(FIXTURE_KEY), 'a key-shaped host message reached the page')
  assert.doesNotMatch(textOf(after), /\[hidden\]/, 'the page repeated the host sentence the fixed line already says')

  // A detail the page does show (a timeout has no fixed sentence of its own) still hides a key.
  const timeout = view({ phase: 'problem', error: { code: 'timeout', message: `Hermes did not answer in time ${FIXTURE_KEY}`, changed: {} } })
  assert.doesNotMatch(textOf(timeout), new RegExp(FIXTURE_KEY))
  assert.match(textOf(timeout), /\[hidden\]/)

  const nothing = view({ phase: 'problem', error: { code: 'failed', message: 'The move did not finish.', changed: {} } })
  assert.match(textOf(nothing), /Nothing was changed\. Hermes is exactly as it was\./)
})

test('the hand-off opens Channels and a Bot\'s settings through the Bot team\'s face, and fails quiet', () => {
  const seen = []
  const load = () => ({ omni: { face: () => ({ actions: { selectPanel: id => seen.push(['panel', id]), openSettings: (page, id) => seen.push(['settings', page, id]) } }) } })
  assert.equal(migrate.openChannels(load), true)
  assert.deepEqual(seen, [['panel', 'omni-channels']])
  assert.equal(migrate.openBotSettings(BOT, load), true)
  assert.deepEqual(seen[1], ['settings', 'bots', BOT])

  assert.equal(migrate.openChannels(() => null), false)
  assert.equal(migrate.openChannels(() => ({ omni: { face: () => null } })), false)
  assert.equal(migrate.openChannels(() => { throw new Error('no team') }), false)
  assert.equal(migrate.openBotSettings('', load), false)
  assert.equal(migrate.openBotSettings(BOT, () => { throw new Error('no team') }), false)
})

test('Not now only ends the step: nothing is started, looked at or switched', () => {
  const calls = []
  const choose = view({ phase: 'choosing', onSkip: () => calls.push('skip'), onPick: () => calls.push('pick') })
  buttons(choose).find(node => textOf(node) === 'Not now').props.onClick()
  const handoff = view({ phase: 'handoff', handoff: { reason: 'no-key' }, onSkip: () => calls.push('handoff-skip'), onCheckAgain: () => calls.push('check'), onOpenChannels: () => calls.push('channels') })
  buttons(handoff).find(node => textOf(node) === 'Not now').props.onClick()
  assert.deepEqual(calls, ['skip', 'handoff-skip'])
})

test('the step carries its own clay, in both themes', () => {
  assert.match(migrate.MIGRATE_CSS, /\.oai-soon\{[^}]*--oai-lilac/)
  assert.match(migrate.MIGRATE_CSS, /\.oai-card \.oai-mig-tool/)
  assert.match(migrate.MIGRATE_CSS, /prefers-reduced-motion/)
  const ready = migrate.TOOLS.filter(tool => tool.ready === true).map(tool => tool.id)
  assert.deepEqual(plain(ready), ['hermes'])
})
