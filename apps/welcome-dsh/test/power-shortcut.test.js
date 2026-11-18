// The power model the welcome shares with the Bot team (src/client/power-shortcut.js): the
// rows' states and words, the power store, and the card each built-in Bot's settings draws.
// The sidebar's power shortcut is gone; a Bot's power lives in that Bot's settings card.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/client/power-shortcut.js'",
      "export * from './src/client/power-store.js'",
      "export { TeamStep, explicitOf, powerLocked, powerOff, POLL_MS } from './src/client/team.js'",
    ].join('\n'),
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@automagik/bots-dsh/client'],
  loader: { '.css': 'text' },
})

// A small hook runtime: state, refs and effects keep their slots across renders, so a component
// runs as it would mounted; effects run after each render when their dependencies changed.
let slots = []
let at = 0
let pending = []
const changed = (before, deps) => !before || !deps || deps.length !== before.length || deps.some((dep, i) => !Object.is(dep, before[i]))
const effect = (run, deps) => {
  const slot = at++
  if (changed(slots[slot], deps)) {
    slots[slot] = deps ?? null
    pending.push(run)
  }
}
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: 'Fragment',
  useState(initial) {
    const slot = at++
    if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
    return [slots[slot], (value) => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value }]
  },
  useRef(current) {
    const slot = at++
    if (!(slot in slots)) slots[slot] = { current }
    return slots[slot]
  },
  useEffect: effect,
  useLayoutEffect: effect,
  useCallback: fn => fn,
  useMemo: make => make(),
  useId: () => 'power-card',
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
}
const fetched = []
let answers = {}
const fetchStub = async (_route, init) => {
  const { endpoint, payload } = JSON.parse(init.body)
  fetched.push({ endpoint, payload })
  const value = typeof answers[endpoint] === 'function' ? answers[endpoint](payload) : answers[endpoint] ?? {}
  return { ok: true, json: async () => ({ ok: true, value }) }
}
const client = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module: client, exports: client.exports, URL, setTimeout, clearTimeout, AbortController, Promise, JSON,
  fetch: fetchStub, matchMedia: () => ({ matches: true }),
  require: name => ({ react, 'react-dom': { createPortal: node => node } })[name],
})
const shortcut = client.exports

function mount(Component, props) {
  slots = []
  const render = () => {
    at = 0
    pending = []
    const tree = Component(props)
    for (const run of pending) run()
    return tree
  }
  return { render }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
function findAll(node, match, out = []) {
  if (Array.isArray(node)) node.forEach(child => findAll(child, match, out))
  else if (node && typeof node === 'object') {
    if (match(node)) out.push(node)
    for (const child of node.children ?? []) findAll(child, match, out)
  }
  return out
}

const OMNI_BOT = { id: 'omni', kind: 'omni', name: 'Omni' }
const GENIE_BOT = { id: 'genie', kind: 'genie', name: 'Genie' }
const UNFOLD_BOT = { id: 'unfold', kind: 'unfold', name: 'Unfold' }
const plain = value => JSON.parse(JSON.stringify(value))
const row = (kind, phase, context, detail = null) => shortcut.powerRow(kind, { phase, detail }, context)

test('each product\'s row follows the plan\'s state table', () => {
  const linked = { bots: [OMNI_BOT, GENIE_BOT], omniLinked: true }
  // On: Omni linked with its Bot, Genie with a Bot of its kind; the action powers it off.
  const omniOn = row('omni', 'asleep', { roster: linked })
  assert.deepEqual([omniOn.state, omniOn.action, omniOn.pressed, omniOn.locked, omniOn.secondary], ['on', 'off', true, false, null])
  assert.equal(shortcut.actionLabel(omniOn), 'Power Omni off')
  assert.equal(shortcut.secondaryLabel(omniOn), null)
  assert.equal(row('genie', 'asleep', { roster: linked }).secondary, null)
  assert.equal(omniOn.text, 'On · Connected')
  assert.equal(row('omni', 'linked', { roster: linked }, { origin: 'omni.example.com' }).text, 'On · Connected to omni.example.com')
  // Genie, once on the team, stays (the team step's box holds its power too): off shows held, and why.
  const genieOn = row('genie', 'asleep', { roster: linked })
  assert.deepEqual([genieOn.state, genieOn.text, genieOn.action, genieOn.locked, genieOn.note], ['on', 'On · Ready for a wish', 'off', true, 'Genie stays on once it joins your team.'])
  // Powered off here: asleep, not on the team, and Power on brings it back.
  const removed = row('omni', 'asleep', { roster: linked, status: { ready: true, installed: true, canInstall: true } }, { removed: true })
  assert.deepEqual([removed.state, removed.text, removed.action], ['off', 'Powered off · not on your team', 'power'])
  // Installed but not connected: power it on, here.
  const plain = { roster: { bots: [] }, status: { ready: true, installed: true, canInstall: true } }
  assert.deepEqual([row('omni', 'asleep', plain).state, row('omni', 'asleep', plain).action, row('omni', 'asleep', plain).text], ['off', 'power', 'Powered off'])
  // Not installed: Install, with what it does in one line.
  const genieMissing = row('genie', 'asleep', { roster: { bots: [] }, status: { ready: false, plugin: { installed: false }, canInstall: true } })
  assert.deepEqual([genieMissing.action, genieMissing.text, genieMissing.note], ['install', 'Not installed', 'Adds the Genie plugin to this DSH. Genie then joins your team.'])
  assert.equal(shortcut.actionLabel(genieMissing), 'Install Genie')
  const omniMissing = row('omni', 'asleep', { roster: { bots: [] }, status: { ready: false, installed: false, canInstall: true } })
  assert.deepEqual([omniMissing.action, omniMissing.note], ['install', 'Adds the Omni plugins to this DSH, then looks for your Omni.'])
  assert.equal(row('genie', 'asleep', { roster: { bots: [] }, status: { ready: false, plugin: { installed: true }, canInstall: true } }).action, 'power')
  // Found or none: where Omni lives is the team step's choice.
  assert.equal(row('omni', 'found', plain, { omnis: [] }).action, 'choose')
  assert.equal(row('omni', 'none', plain).action, 'choose')
  // Installing or starting: held as the team step's box is, a spinner, and the install goes on.
  const working = row('omni', 'installing', plain, null)
  assert.deepEqual([working.state, working.action, working.working, working.text, working.note], ['working', null, true, 'Installing Omni…', 'You can close this. The install keeps going.'])
  assert.equal(row('genie', 'starting', plain).text, 'Starting Genie in this DSH…')
  // Waking or looking: it can still be powered off, as on its box.
  assert.deepEqual([row('omni', 'looking', plain).action, row('omni', 'looking', plain).pressed], ['off', true])
  assert.equal(row('omni', 'pairing', plain, { pairing: {} }).action, 'off')
  // Restart: text only.
  assert.deepEqual([row('genie', 'restart', plain).action, row('genie', 'restart', plain).text], [null, 'Installed · restart DSH to start it'])
  // Failed: its message as an alert, and try again.
  const failed = row('omni', 'failed', plain, { message: 'git was not found' })
  assert.deepEqual([failed.state, failed.action, failed.alert], ['attention', 'retry', 'git was not found'])
  // Linked, but the Omni Bot was deleted: add it back.
  assert.equal(row('omni', 'asleep', { roster: { bots: [], omniLinked: true, omniAddable: true } }).secondary, 'add')
  // No plugin manager: the Plugins page.
  assert.equal(row('omni', 'asleep', { roster: { bots: [] }, status: { ready: false, canInstall: false } }).action, 'plugins')
  // A read-only team: text only.
  assert.equal(row('omni', 'asleep', { roster: { bots: [], readOnly: 'Read only' }, status: { canInstall: true } }).action, null)
  assert.equal(row('genie', 'asleep', { roster: { bots: [GENIE_BOT], readOnly: 'Read only' } }).action, null)
})

test('an install says its step and its place, from the host\'s job', () => {
  const genie = install => ({ genie: { install } })
  assert.equal(shortcut.workingText('genie', 'installing', genie({ phase: 'installing', steps: ['git', 'team', 'genie'], current: 'team', done: ['git'] })), 'Installing Genie · 2 of 3 · Bot team')
  assert.equal(shortcut.workingText('genie', 'installing', genie({ phase: 'installing', steps: ['git', 'team', 'genie'], current: 'git', done: [] })), 'Installing Genie · 1 of 3 · Checking git')
  assert.equal(shortcut.workingText('genie', 'installing', genie({ phase: 'installing', steps: ['team', 'genie'], current: 'genie', done: ['team'] })), 'Installing Genie · 2 of 2 · Genie plugin')
  // Before the job says: the team step's own line.
  assert.equal(shortcut.workingText('genie', 'installing', genie(null)), 'Installing Genie…')
  assert.equal(shortcut.workingText('genie', 'installing', genie({ phase: 'installing', log: '' })), 'Installing Genie…')
  const plugins = { plugins: [{ name: 'a', title: 'Bot team' }, { name: 'b', title: 'Omni channels' }, { name: 'c', title: 'Omni canvases' }], install: { phase: 'installing', current: 'b', done: ['a'] } }
  assert.equal(shortcut.workingText('omni', 'installing', { plugins }), 'Installing Omni · 2 of 3 · Omni channels')
  assert.equal(shortcut.workingText('omni', 'starting', { plugins }), 'Starting Omni in this DSH…')
  assert.equal(shortcut.powerRow('genie', { phase: 'installing', detail: genie({ steps: ['git', 'team', 'genie'], current: 'team', done: ['git'] }) }).text, 'Installing Genie · 2 of 3 · Bot team')
})

test('several Genie Bots: on, and the row wears the Main one\'s mark', () => {
  const roster = { bots: [GENIE_BOT, { id: 'genie-2', kind: 'genie' }], mainBotId: 'genie-2' }
  assert.equal(row('genie', 'asleep', { roster }).bot.id, 'genie-2')
  assert.equal(row('genie', 'asleep', { roster: { bots: [GENIE_BOT, { id: 'genie-2', kind: 'genie' }] } }).bot.id, 'genie')
})

test('Unfold is a read-only row: on when its Bot is there, with no action', () => {
  const unfold = row('unfold', 'asleep', { roster: { bots: [UNFOLD_BOT] } })
  assert.deepEqual([unfold.state, unfold.action, unfold.text], ['on', null, 'On your team'])
  assert.deepEqual([row('unfold', 'asleep', { roster: { bots: [] } }).state, row('unfold', 'asleep', { roster: { bots: [] } }).action], ['off', null])
})

test('a power-on keeps running in the store after its view goes, and a second press starts nothing', async () => {
  shortcut.resetPower()
  let release
  let runs = 0
  const run = async ({ show, signal }) => {
    runs += 1
    show('installing')
    await new Promise((resolve) => { release = resolve })
    if (signal.aborted) return
    show('ready', { bot: GENIE_BOT })
  }
  const seen = []
  const off = shortcut.subscribePower(() => seen.push(shortcut.powerOf('genie').phase))
  off() // the view that started it is gone
  assert.ok(shortcut.startPower('genie', run))
  assert.equal(shortcut.startPower('genie', run), null)
  assert.equal(runs, 1)
  assert.equal(shortcut.powerOf('genie').phase, 'installing')
  release()
  await settle()
  assert.equal(shortcut.powerOf('genie').phase, 'ready')
  assert.deepEqual(seen, [])
  // Only an explicit stop aborts it.
  shortcut.startPower('omni', async ({ show, signal }) => {
    show('waking')
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { name: 'AbortError' }))))
  })
  shortcut.stopPower('omni')
  await settle()
  assert.equal(shortcut.powerOf('omni').phase, 'waking')
  assert.equal(shortcut.powerSignal('omni').aborted, true)
  // A run that throws ends failed, with its message.
  shortcut.runPower('genie', async () => { throw new Error('no git') })
  await settle()
  assert.deepEqual(plain(shortcut.powerOf('genie')), { phase: 'failed', detail: { message: 'no git' } })
  shortcut.resetPower()
})

test('the team step opened on purpose only closes on Continue: no team-save, no rename', async () => {
  for (const [explicit, saves] of [[true, false], [false, true]]) {
    shortcut.resetPower()
    fetched.length = 0
    answers = { state: { companionName: 'Otto', teamDone: false, preload: null }, 'team-save': { omni: false, genie: false } }
    let completed = 0
    const props = { stepId: 'omni-team', explicit, complete: () => { completed += 1 } }
    const view = mount(shortcut.TeamStep, props)
    view.render()
    await settle()
    const tree = view.render()
    assert.ok(tree, `the step shows (explicit ${explicit})`)
    const go = findAll(tree, node => node.type === 'button' && String(node.props.className).includes('oai-primary'))[0]
    go.props.onClick()
    await settle()
    await settle()
    assert.equal(fetched.some(call => call.endpoint === 'team-save'), saves)
    if (!saves) assert.equal(completed, 1)
  }
  shortcut.resetPower()
  assert.equal(shortcut.explicitOf({ explicit: true }), true)
  assert.equal(shortcut.explicitOf({}), false)
})

test('powering off from a card is the team step\'s own off: the run stops, nothing else is undone', async () => {
  shortcut.resetPower()
  fetched.length = 0
  // A linked Omni: off only puts its box to sleep. No unlink, no Bot removed, no host call.
  shortcut.showPower('omni', 'linked', { origin: 'omni.example.com' })
  shortcut.powerOff('omni')
  assert.deepEqual(plain(shortcut.powerOf('omni')), { phase: 'asleep', detail: { removed: true } })
  assert.deepEqual(fetched, [])
  // Waiting on the phone: the sign-in is cancelled, as the box's own off does.
  const asked = []
  shortcut.showPower('omni', 'pairing', { pairing: { code: 'X' } })
  shortcut.powerOff('omni', shortcut.powerOf('omni'), endpoint => { asked.push(endpoint); return Promise.resolve({}) })
  assert.deepEqual(asked, ['omni-pair-cancel'])
  // A run in progress is stopped.
  shortcut.startPower('genie', async ({ show, signal }) => {
    show('waking')
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { name: 'AbortError' }))))
  })
  shortcut.powerOff('genie')
  await settle()
  assert.equal(shortcut.powerSignal('genie').aborted, true)
  assert.equal(shortcut.powerOf('genie').phase, 'asleep')
  // Held while it installs or starts, and Genie once on the team.
  assert.deepEqual(['installing', 'starting', 'ready', 'linked'].map(phase => shortcut.powerLocked('omni', phase)), [true, true, false, false])
  assert.equal(shortcut.powerLocked('genie', 'ready'), true)
  shortcut.resetPower()
})

// The Bot team's pieces, as its settings page draws them. The test reads the component's own
// props: it does not mount the Bot team's React.
const Card = ({ title, children }) => ({ type: Card, props: { title }, children })
const Row = ({ label, hint, children }) => ({ type: Row, props: { label, hint }, children })
const SwitchRow = ({ label, hint, on, disabled, onChange }) => ({ type: SwitchRow, props: { label, hint, on, disabled, onChange }, children: [] })
const cardProps = (bot, roster, extra = {}) => ({ bot, roster, Card, Row, SwitchRow, ...extra })
const drawCard = (bot, roster, extra = {}) => mount(shortcut.PowerSettingsCard, cardProps(bot, roster, extra)).render()
const switchOf = tree => findAll(tree, node => node.type === SwitchRow)[0]

test('the power card is offered for omni, genie and unfold, and for no other kind', () => {
  for (const [kind, bot] of [['omni', OMNI_BOT], ['genie', GENIE_BOT], ['unfold', UNFOLD_BOT]]) {
    shortcut.resetPower()
    const tree = drawCard(bot, { bots: [bot] })
    assert.equal(switchOf(tree)?.props.label, 'Power', `${kind} gets the card`)
  }
  shortcut.resetPower()
  const other = { id: 'x', kind: 'agent', name: 'X' }
  assert.equal(drawCard(other, { bots: [other] }), null)
})

test('the card\'s switch calls the existing power-on and power-off', () => {
  shortcut.resetPower()
  const started = []
  const stopped = []
  const start = (kind, run) => { started.push([kind, run.name]) }
  const stop = kind => { stopped.push(kind) }
  const omni = { ...OMNI_BOT }
  let sw = switchOf(drawCard(omni, { bots: [omni], omniLinked: true }, { start, stop }))
  assert.equal(sw.props.on, true)
  sw.props.onChange(false)
  assert.deepEqual(stopped, ['omni'])
  shortcut.resetPower()
  sw = switchOf(drawCard(omni, { bots: [omni] }, { start, stop }))
  assert.equal(sw.props.on, false)
  sw.props.onChange(true)
  assert.deepEqual(started, [['omni', 'powerOn']])
  shortcut.resetPower()
  sw = switchOf(drawCard(GENIE_BOT, { bots: [] }, { start, stop }))
  assert.equal(sw.props.on, false)
  sw.props.onChange(true)
  shortcut.resetPower()
  sw = switchOf(drawCard(UNFOLD_BOT, { bots: [] }, { start, stop }))
  assert.equal(sw.props.on, false)
  sw.props.onChange(true)
  assert.deepEqual(started, [['omni', 'powerOn'], ['genie', 'geniePowerOn'], ['unfold', 'unfoldPowerOn']])
})

test('the card\'s label follows the power state, in the existing words', () => {
  shortcut.resetPower()
  let sw = switchOf(drawCard(OMNI_BOT, { bots: [OMNI_BOT], omniLinked: true }))
  assert.equal(sw.props.on, true)
  assert.equal(sw.props.hint, 'On · Connected')
  shortcut.showPower('omni', 'linked', { origin: 'omni.example.com' })
  sw = switchOf(drawCard(OMNI_BOT, { bots: [OMNI_BOT], omniLinked: true }))
  assert.equal(sw.props.hint, 'On · Connected to omni.example.com')
  shortcut.resetPower()
  sw = switchOf(drawCard(OMNI_BOT, { bots: [] }))
  assert.deepEqual([sw.props.on, sw.props.hint, sw.props.disabled], [false, 'Powered off', false])
  // Working: the switch is on its way on, and held.
  shortcut.showPower('omni', 'waking')
  sw = switchOf(drawCard(OMNI_BOT, { bots: [] }))
  assert.deepEqual([sw.props.on, sw.props.hint, sw.props.disabled], [true, 'Waking up…', true])
  // Genie, once on the team, is on and held; its note says why.
  shortcut.resetPower()
  shortcut.showPower('genie', 'ready', { bot: GENIE_BOT })
  const genie = drawCard(GENIE_BOT, { bots: [GENIE_BOT] })
  sw = switchOf(genie)
  assert.deepEqual([sw.props.on, sw.props.hint, sw.props.disabled], [true, 'On · Ready for a wish', true])
  assert.ok(findAll(genie, node => node.props?.className === 'bt-bs-shell-note').some(node => [].concat(node.children).join('') === 'Genie stays on once it joins your team.'))
})

test('a read-only team\'s card is text only, with the same state line', () => {
  shortcut.resetPower()
  const tree = drawCard(OMNI_BOT, { bots: [OMNI_BOT], omniLinked: true, readOnly: 'Read only' })
  assert.equal(findAll(tree, node => node.type === SwitchRow).length, 0)
  const text = findAll(tree, node => node.type === Row)[0]
  assert.deepEqual([text.props.label, text.props.hint], ['Power', 'On · Connected'])
})

test('the settings card registers on the Bot team\'s botSettings, and leaves with its disposer', () => {
  const entries = []
  const botSettings = { register: (entry) => { entries.push(entry); return () => entries.splice(entries.indexOf(entry), 1) } }
  const off = shortcut.installPowerSettings(() => ({ omni: { botSettings } }))
  assert.equal(typeof off, 'function')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'welcome-power')
  assert.equal(entries[0].Component, shortcut.PowerSettingsCard)
  off()
  assert.equal(entries.length, 0)
})

test('without the Bot team, or with a client that has no botSettings, there is no card and nothing throws', () => {
  for (const botTeam of [
    () => { throw new Error('Module @automagik/bots-dsh/client is not registered') },
    () => undefined,
    () => ({}),
    () => ({ omni: null }),
    () => ({ omni: {} }),
  ]) {
    const off = shortcut.installPowerSettings(botTeam)
    assert.equal(typeof off, 'function')
    off()
  }
})
