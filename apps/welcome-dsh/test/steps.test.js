import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { install } from '../src/host/endpoint.js'
import { fakeContext } from './fake-ctx.js'

// The client modules, with a React that records elements instead of rendering them.
// `scope` adds globals (a page's location and navigator); `gated` hands the next useState(undefined)
// these values in turn, as a step's gate state once it has arrived.
async function load(file, { scope = {}, gated = [] } = {}) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL(`../src/client/${file}`, import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
    external: ['react', 'react-dom'],
    loader: { '.css': 'text' },
  })
  const module = { exports: {} }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState: initial => [initial === undefined && gated.length > 0 ? gated.shift() : typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {}, useRef: current => ({ current }), useCallback: fn => fn,
    // The team step reads its power store (power-store.js) through this hook.
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, URL, setTimeout, clearTimeout, require: name => ({ react, 'react-dom': { createPortal: node => node } })[name], ...scope })
  return module.exports
}
// Values made inside the vm compare by shape, not by realm.
const plain = value => JSON.parse(JSON.stringify(value))

const { gate, finish, finishInto, FLAG_OF, announceStep, railSteps } = await load('stage.js')

function recorder(state = {}) {
  const log = []
  const request = async (endpoint, payload) => {
    log.push(payload === undefined ? endpoint : `${endpoint} ${JSON.stringify(payload)}`)
    return endpoint === 'state' ? state : { ok: true }
  }
  const props = stepId => ({ stepId, complete: () => log.push('complete'), openSection: id => log.push(`open ${id}`) })
  return { log, request, props }
}

test('a step whose done flag is set completes at once and shows nothing', async () => {
  for (const [stepId, flag] of Object.entries(FLAG_OF)) {
    const { log, request, props } = recorder({ [flag]: true })
    assert.equal(await gate(props(stepId), request), null)
    assert.deepEqual(log, ['state', 'complete'])
  }
})

test('a step shows when its flag is unset, or when the user reopened it', async () => {
  const fresh = recorder({ companionDone: false, aiConnected: true })
  assert.deepEqual(plain(await gate(fresh.props('omni-companion'), fresh.request)), { companionDone: false, aiConnected: true })
  assert.deepEqual(fresh.log, ['state'])

  const reopened = recorder({ companionDone: true })
  assert.deepEqual(plain(await gate({ ...reopened.props('omni-companion'), explicit: true }, reopened.request)), { companionDone: true })
  assert.deepEqual(reopened.log, ['state'])

  const offline = recorder()
  assert.deepEqual(plain(await gate(offline.props('omni-connect-ai'), async () => { throw new Error('down') })), {})
})

test('finishing writes the flag, then completes; a tile completes before it opens a section', async () => {
  const done = recorder()
  await finish(done.props('omni-team'), done.request)
  assert.deepEqual(done.log, ['done {"stepId":"omni-team"}', 'complete'])

  const tile = recorder()
  await finishInto(tile.props('omni-connect-ai'), 'models', tile.request)
  assert.deepEqual(tile.log, ['done {"stepId":"omni-connect-ai"}', 'complete', 'open models'])

  const failing = recorder()
  await finish(failing.props('omni-companion'), async () => { throw new Error('down') })
  assert.deepEqual(failing.log, ['complete'])
})

test('Connect AI is a list of switches: found first, then 4 more and the rest on demand', async () => {
  const { sections, onCount, flipAction, FIRST_OTHERS } = await load('connect-ai.js')
  const rows = [
    { id: 'claude', found: 'Signed in to Claude', ready: true, on: true },
    { id: 'chatgpt', found: null, ready: false, on: false },
    { id: 'deepseek', found: 'DEEPSEEK_API_KEY found', ready: true, on: true },
    { id: 'openai', found: null, ready: true, on: true },
    { id: 'kimi', found: null, ready: true, on: false },
  ]
  const { found, others } = plain(sections(rows))
  // On rows count as found: they are what this computer already uses.
  assert.deepEqual(found.map(row => row.id), ['claude', 'deepseek', 'openai'])
  assert.deepEqual(others.map(row => row.id), ['chatgpt', 'kimi'])
  assert.equal(FIRST_OTHERS, 4)
  assert.equal(onCount(rows), 3)
  // Flipping: off when on, on when set up, else open its setup in place.
  assert.deepEqual(rows.map(flipAction), ['off', 'setup', 'off', 'off', 'on'])
})

test('Continue needs one AI really on; Skip always finishes', async () => {
  const { onCount } = await load('connect-ai.js')
  assert.equal(onCount([{ on: false }, { on: false }]), 0)
  assert.equal(onCount([]), 0)
  assert.equal(onCount([{ on: false }, { on: true }]), 1)
})

test('every row that signs in names its own provider; Claude\'s key is pi-ai\'s anthropic route, offered once', async () => {
  const { PROVIDER_OF, LOGOS, CLI_ROWS } = await load('connect-ai.js')
  const providers = plain(PROVIDER_OF)
  assert.deepEqual([providers.claude, providers.kimi, providers.copilot, providers.grok], ['anthropic', 'kimi-coding', 'github-copilot', 'xai'])
  // ChatGPT signs in only through Codex, Claude through Claude Code (or its key): no DSH sign-in.
  assert.equal(providers.chatgpt, undefined)
  assert.deepEqual(plain(CLI_ROWS), { claude: 'acp-claude', chatgpt: 'acp-codex' })
  assert.equal(Object.values(providers).filter(provider => provider === 'anthropic').length, 1)
  assert.ok(!Object.values(providers).includes('claude'))
  assert.equal(typeof plain(LOGOS).claude, 'string')
  assert.equal(plain(LOGOS).anthropic, undefined)
})

test('the rail names only the steps this DSH has: Connect Omni only with the plugin that brings it', () => {
  const scope = {}
  const labels = current => plain(railSteps(current, scope).map(([, label]) => label))
  for (const id of ['omni-companion', 'omni-team', 'omni-connect-ai']) announceStep(id, scope)
  assert.deepEqual(labels('omni-companion'), ['Your companion', 'Your team', 'Connect AI'])
  const leave = announceStep('omni-connect', scope)
  const leaveMigrate = announceStep('omni-migrate', scope)
  assert.deepEqual(labels('omni-connect-ai'), ['Your companion', 'Your team', 'Connect Omni', 'From another tool', 'Connect AI'])
  leaveMigrate()
  assert.deepEqual(labels('omni-connect-ai'), ['Your companion', 'Your team', 'Connect Omni', 'Connect AI'])
  leave()
  assert.deepEqual(labels('omni-connect-ai'), ['Your companion', 'Your team', 'Connect AI'])
  // A step that never announced itself still shows where it is.
  assert.deepEqual(plain(railSteps('omni-connect', {}).map(([id]) => id)), ['omni-connect'])
})

test('a subscription takes the next free account slot; only vendors nothing else covers are offered', async () => {
  const { nextIndex, signedInCount, SUBSCRIPTION_TILES } = await load('subscriptions.js')
  const { subscriptionRows } = await load('connect-ai.js')
  const accounts = [
    { provider: 'kiro', index: 1, configured: true },
    { provider: 'kiro', index: 2, configured: false },
    { provider: 'cursor', index: 1, configured: true },
    { provider: 'cursor', index: 3, configured: true },
  ]
  assert.equal(nextIndex(accounts, 'kiro'), 2)
  assert.equal(nextIndex(accounts, 'cursor'), 4)
  assert.equal(nextIndex(accounts, 'glm'), 1)
  assert.equal(nextIndex(null, 'glm'), 1)
  assert.equal(signedInCount(accounts, 'cursor'), 2)
  // Claude, ChatGPT, Kimi, Copilot and Grok each have their own row: never offered twice.
  const ids = plain(SUBSCRIPTION_TILES).map(tile => tile.provider)
  for (const id of ['claude', 'codex', 'kimi', 'copilot', 'grok', 'ollama', 'openai-codex', 'kimi-coding', 'anthropic']) assert.ok(!ids.includes(id), id)
  // A row per vendor, on when signed in and not hidden.
  const rows = plain(subscriptionRows({ accounts: [{ provider: 'cursor', index: 1 }, { provider: 'cursor', index: 3 }, { provider: 'kiro', index: 1 }], hidden: ['kiro'] }))
  const by = Object.fromEntries(rows.map(row => [row.tile.provider, row]))
  assert.deepEqual([by.cursor.on, by.cursor.found], [true, '2 accounts'])
  assert.deepEqual([by.kiro.on, by.kiro.ready], [false, true])
  assert.deepEqual([by.glm.on, by.glm.ready, by.glm.found], [false, false, null])
  assert.deepEqual(plain(subscriptionRows(null)), [])
})

// Expands function components, so a test reads the elements a card really draws.
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

const team = await load('team.js')
const { ONBOARD_CSS } = await load('onboard-css.js')

// The host as the card calls it: omni-ai (plugins) and the Omni plugins' endpoint (omni-ui).
function powerHost({ plugins = { ready: true }, polls = [], install, link = { linked: false }, omnis = [] } = {}) {
  const calls = []
  const omniAi = async (endpoint) => {
    calls.push(endpoint)
    if (endpoint === 'omni-plugins-install') {
      if (install instanceof Error) throw install
      return install
    }
    return polls.length > 0 ? polls.shift() : plugins
  }
  const omniUi = async (endpoint) => {
    calls.push(endpoint)
    return endpoint === 'omni-link' ? link : { omnis, sandbox: { home: '/home/someone/.omni/sandbox' } }
  }
  const shown = []
  const waits = []
  const show = (phase, detail) => shown.push(detail === undefined ? phase : [phase, plain(detail)])
  const wait = async (ms) => { waits.push(ms) }
  return { calls, shown, waits, run: (options = {}) => team.powerOn({ show, omniAi, omniUi, wait, quick: false, ...options }) }
}
const phases = shown => shown.map(entry => (Array.isArray(entry) ? entry[0] : entry))

test('power on, with the Omni plugins here: Omni wakes and looks, and offers what it found', async () => {
  const omni = { id: 'cli:default', url: 'http://127.0.0.1:8882', local: true, hasKey: true, version: '2.261023.28' }
  const fake = powerHost({ omnis: [omni] })
  assert.equal(await fake.run(), 'found')
  assert.deepEqual(phases(fake.shown), ['waking', 'looking', 'found'])
  assert.deepEqual(fake.calls, ['omni-plugins', 'omni-link', 'omni-discover'])
  assert.deepEqual(fake.shown.at(-1)[1].omnis, [omni])
  assert.equal(fake.waits[0], team.WAKE_MS)
})

test('power on, in a plain DSH: the Omni plugins install, start, and then Omni looks', async () => {
  const rows = [{ name: '@automagik/bots-dsh', title: 'Bot team', installed: false }]
  const installing = { ready: false, plugins: rows, install: { phase: 'installing', current: '@automagik/bots-dsh', done: [] } }
  const fake = powerHost({
    plugins: { ready: false, plugins: rows, install: null },
    install: installing,
    polls: [{ ready: false, plugins: rows, install: null }, installing, { ready: false, plugins: rows, install: { phase: 'done', done: ['@automagik/bots-dsh'] } }, { ready: true, plugins: rows, install: { phase: 'done', done: ['@automagik/bots-dsh'] } }],
  })
  assert.equal(await fake.run(), 'none')
  assert.deepEqual(phases(fake.shown), ['waking', 'installing', 'installing', 'installing', 'starting', 'looking', 'none'])
  assert.deepEqual(fake.calls, ['omni-plugins', 'omni-plugins-install', 'omni-plugins', 'omni-plugins', 'omni-plugins', 'omni-link', 'omni-discover'])
  assert.equal(fake.shown.at(-1)[1].sandbox.home, '/home/someone/.omni/sandbox')
})

test('a delayed gated Power action cannot install Omni under the next owner', async () => {
  const installs = []
  const { ctx, routes } = fakeContext({ entries: { 'omni-ai': {} }, services: {
    omniTeam: { ownerViewer: request => ({ id: request.headers.get('x-automagik-principal') }) },
    pluginManager: {
      listBundles: async () => [{ name: '@automagik/welcome-dsh', source: 'link:/fixture/apps/welcome-dsh' }],
      installBundle: async spec => { installs.push(spec); return { application: 'applied' } },
    },
  } })
  install(ctx, { env: { AUTOMAGIK_MULTIUSER: '1' } })
  const route = routes[0]
  const requests = []
  let person = 'owner-a'
  const send = body => route.fetch(new Request('https://workspace.invalid' + route.path, {
    method: 'POST', body, headers: { 'x-automagik-principal': person },
  }))
  const gated = await load('team.js', { scope: {
    __AUTOMAGIK_VIEW__: { version: 1, role: 'owner' },
    __AUTOMAGIK_MOUNTED_VIEWER__: { id: 'owner-a', check() {}, refused() {} },
    fetch: (path, { body }) => {
      assert.equal(path, 'api/omni-ai')
      requests.push([person, JSON.parse(body)])
      return send(body)
    },
  } })
  const wake = Promise.withResolvers()
  const shown = []
  const power = gated.powerOn({ show: phase => shown.push(phase), wait: () => wake.promise, quick: false })
  assert.deepEqual(shown, ['waking'])
  assert.deepEqual(requests, [])
  // The browser's cookie changes while the previous document is still mounted.
  person = 'owner-b'
  wake.resolve()
  assert.equal(await power, 'failed')
  assert.deepEqual(requests, [
    ['owner-b', { endpoint: 'omni-plugins', payload: null }],
    ['owner-b', { endpoint: 'omni-plugins-install', payload: null, viewer: 'owner-a' }],
  ])
  const missing = await send(JSON.stringify({ endpoint: 'omni-plugins-install', payload: null }))
  assert.equal((await missing.json()).error?.code, 'bot/viewer-changed')
  const status = await send(JSON.stringify({ endpoint: 'omni-plugins', payload: null }))
  assert.equal((await status.json()).value.install, null)
  assert.deepEqual(installs, [])
  const current = await send(JSON.stringify({ endpoint: 'done', payload: { stepId: 'omni-team' }, viewer: 'owner-b' }))
  assert.deepEqual(await current.json(), { ok: true, value: { teamDone: true } })
})

test('power on ends at linked, restart or failed when that is where it stands', async () => {
  const linked = powerHost({ link: { linked: true, origin: 'omni.example.com' } })
  assert.equal(await linked.run(), 'linked')
  assert.deepEqual(linked.shown.at(-1), ['linked', { origin: 'omni.example.com' }])
  assert.ok(!linked.calls.includes('omni-discover'))

  const refused = powerHost({ plugins: { ready: false }, install: new Error('This DSH has no plugin manager to install Omni with.') })
  assert.equal(await refused.run(), 'failed')
  assert.match(refused.shown.at(-1)[1].message, /no plugin manager/)

  const failed = powerHost({ plugins: { ready: false }, install: { ready: false, install: { phase: 'failed', error: 'Bot team: offline' } } })
  assert.equal(await failed.run(), 'failed')
  assert.equal(failed.shown.at(-1)[1].message, 'Bot team: offline')

  // Installed and ready, yet the channels' route is not served yet.
  const omniUi = async () => { throw Object.assign(new Error('DSH answered HTTP 404'), { code: 'HTTP_404' }) }
  assert.equal(await team.powerOn({ show: () => {}, omniAi: async () => ({ ready: true }), omniUi, wait: async () => {}, quick: true }), 'restart')

  const restart = powerHost({ plugins: { ready: false }, install: { ready: false, install: { phase: 'restart', done: [] } } })
  assert.equal(await restart.run(), 'restart')

  // Installed, yet the plugins never came up: a restart is asked, not an endless wait.
  const stuck = powerHost({ plugins: { ready: false, install: { phase: 'done', done: [] } }, install: { ready: false, install: { phase: 'done', done: [] } } })
  assert.equal(await stuck.run(), 'restart')
  assert.equal(stuck.calls.filter(call => call === 'omni-plugins').length, 1 + team.READY_POLLS)
})

test('power off mid-way stops the run: nothing after it is shown', async () => {
  const controller = new AbortController()
  const fake = powerHost()
  const wait = async () => { controller.abort() }
  await assert.rejects(fake.run({ signal: controller.signal, wait }), { name: 'AbortError' })
  assert.deepEqual(phases(fake.shown), ['waking'])
  assert.deepEqual(fake.calls, [])
})

test('reduced motion skips the waking and looking pauses', async () => {
  const fake = powerHost({ omnis: [] })
  await fake.run({ quick: true })
  assert.ok(fake.waits.every(ms => ms === 0), JSON.stringify(fake.waits))
  const css = (await load('onboard-css.js')).ONBOARD_CSS
  const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'))
  for (const name of ['.oai-zzz i', '.oai-scan i', '.oai-power', '.oai-eyes', '.oai-octo-wrap .oai-octo']) assert.ok(reduced.includes(name), `${name} keeps moving under reduced motion`)
})

const omniType = {
  type: 'omni',
  groups: [
    { id: 'model', label: 'Model', rows: [{ id: 'model', label: 'GPT-5.5', detail: 'juice/gpt-5.5' }, { id: 'thinking', label: 'Thinking', detail: 'Medium' }] },
    { id: 'plugins', label: 'Plugins', rows: [{ id: '@automagik/bots-dsh', label: 'Bot team', version: '2.261023.28', installed: true }, { id: '@automagik/omni-canvas-dsh', label: 'Omni canvases', version: '2.261023.28', installed: false }] },
    { id: 'tools', label: 'Tools', rows: [{ id: 'read', label: 'Read channels and chats', tools: ['omni_channels'], on: true, locked: true }, { id: 'send', label: 'Send, react and delete', tools: ['omni_send'], on: true }, { id: 'computer', label: 'Shell and files', tools: ['bash'], on: false }] },
    { id: 'skills', label: 'Skills', rows: [], empty: 'None preloaded.' },
    { id: 'setup', label: 'Setup', rows: [{ id: 'folder', label: 'Folder', detail: '~/.omni/team/omni' }] },
  ],
}

test('the capability list is the Bot type\'s groups, with a switch only where it is tunable', () => {
  const toggles = []
  const tree = render(team.Capabilities({ type: omniType, abilities: { send: false }, onToggle: (id, on) => toggles.push([id, on]) }))
  assert.deepEqual(findAll(tree, node => node.type === 'h3').map(textOf), ['Model', 'Plugins', 'Tools', 'Skills', 'Setup'])
  const cap = id => findAll(tree, node => node.props['data-cap'] === id)[0]
  assert.match(textOf(cap('model')), /GPT-5\.5/)
  assert.match(textOf(cap('@automagik/bots-dsh')), /v2\.261023\.28/)
  assert.match(textOf(cap('@automagik/omni-canvas-dsh')), /Installs when Omni powers on/)
  assert.match(textOf(cap('read')), /Always on/)
  const switches = findAll(tree, node => node.props.role === 'switch')
  assert.deepEqual(switches.map(node => node.props['aria-label']), ['Send, react and delete for this Bot', 'Shell and files for this Bot'])
  assert.deepEqual(switches.map(node => node.props['aria-checked']), [false, false])
  switches[0].props.onClick()
  assert.deepEqual(toggles, [['send', true]])
  assert.match(textOf(findAll(tree, byClass('oai-cap-group'))[3]), /None preloaded/)
  // No stat bars: nothing drawn is a 0-5 meter.
  assert.equal(findAll(tree, node => /oai-(bar|pip|stat)/.test(String(node.props.className ?? ''))).length, 0)
  assert.deepEqual(plain(team.abilitiesOf(omniType)), { read: true, send: true, computer: false })
  assert.equal(textOf(render(team.Capabilities({ type: null }))), 'Reading what it starts with…')
})

const card = (phase, detail = null, extra = {}, live = null) => render(team.OmniCard({ power: { phase, detail, busy: null, problem: null, use: () => {}, remote: () => {}, local: () => {}, cancelPairing: () => {}, ...extra }, onPower: () => {}, type: omniType, abilities: {}, onToggle: () => {}, live }))

test('once connected, the box shows the linked Omni\'s real channels with their live dots, and only then', () => {
  const live = { configured: true, channels: [{ id: 'a', type: 'whatsapp-baileys', name: 'pessoal', status: 'connected' }, { id: 'b', type: 'telegram', name: 'bot', status: 'disconnected' }] }
  const tree = card('linked', { origin: 'omni.example.com' }, {}, live)
  const rows = findAll(tree, node => node.type === 'li' && node.children.some(child => byClass('oai-dot')(child)))
  assert.deepEqual(rows.map(textOf), ['WhatsApp · pessoal', 'Telegram · bot'])
  assert.deepEqual(rows.map(row => row.children[0].props.className), ['oai-dot ok', 'oai-dot warn'])
  // Its host only: no counts the overview cannot vouch for.
  assert.equal(textOf(findAll(tree, byClass('oai-status'))[0]), 'Connected to omni.example.com')
  for (const phase of ['asleep', 'waking', 'looking', 'found', 'none']) assert.equal(findAll(card(phase, { omnis: [] }, {}, live), byClass('oai-menu')).length, 0, `${phase} shows the menu`)
})

test('a long folder is shortened in the middle', () => {
  assert.equal(team.shortPath('~/.omni/ui/workspace/omni'), '~/…/workspace/omni')
  assert.equal(team.shortPath('~/team/omni'), '~/team/omni')
  assert.equal(team.shortPath('/srv/omni/ui/workspace/omni'), '/…/workspace/omni')
})

// Every part of the card outside the box: what must not grow while Omni works.
const outsideBox = tree => findAll(tree, node => node !== tree && !byClass('oai-box')(node) && node.type !== undefined).filter(node => !findAll(tree, byClass('oai-box')).some(box => findAll(box, other => other === node).length > 0))

test('the default card is the box, the name and one sentence; the capabilities wait behind one closed disclosure', () => {
  const asleep = card('asleep')
  const [box] = findAll(asleep, byClass('oai-box'))
  assert.ok(byClass('oai-is-asleep')(box))
  assert.ok(!byClass('oai-chosen')(asleep))
  // The machine's switch is on the box.
  const [button] = findAll(box, byClass('oai-power'))
  assert.deepEqual([button.props['aria-pressed'], button.props['aria-label']], [false, 'Power Omni on'])
  assert.equal(findAll(box, byClass('oai-zzz')).length, 1)
  // Omni in its box: its own asleep face, not its awake one dimmed.
  assert.match(findAll(box, byClass('oai-octo-wrap'))[0].props.dangerouslySetInnerHTML.__html, /class="oai-octo oai-clay oai-clay-omni" data-face="asleep"/)
  assert.equal(textOf(findAll(box, byClass('oai-status'))[0]), 'Powered off')
  // One disclosure, closed, holding every capability row; no class title, no menu.
  const [starts] = findAll(asleep, node => node.type === 'details')
  assert.ok(byClass('oai-starts')(starts))
  assert.equal(starts.props.open, undefined)
  assert.equal(textOf(findAll(starts, node => node.type === 'summary')[0]), 'What it starts with')
  const rows = findAll(asleep, node => node.props?.['data-cap'] !== undefined)
  assert.ok(rows.length > 0)
  assert.ok(rows.every(row => findAll(starts, node => node === row).length === 1), 'a capability row sits outside the disclosure')
  assert.equal(findAll(asleep, byClass('oai-class')).length, 0)
  assert.equal(findAll(asleep, byClass('oai-menu')).length, 0)
  assert.deepEqual(findAll(asleep, node => node.type === 'p' && byClass('oai-about')(node)).map(textOf), ['Every chat on every channel, answered by your team.'])
  assert.equal(findAll(asleep, byClass('oai-team-line')).length, 0)
  assert.equal(textOf(findAll(card('asleep', { removed: true }), byClass('oai-status'))[0]), 'Powered off · not on your team')

  const waking = card('waking')
  assert.ok(byClass('oai-chosen')(waking))
  const [line] = findAll(waking, byClass('oai-team-line'))
  assert.match(textOf(line), /On your team/)
  assert.equal(textOf(findAll(line, byClass('oai-remove'))[0]), 'Remove')
  assert.equal(findAll(waking, byClass('oai-zzz')).length, 0)
})

test('every phase happens inside the box: outside it, the card stays the same', () => {
  const omnis = [
    { id: 'sandbox', source: 'sandbox', url: 'http://127.0.0.1:18882', local: true, hasKey: true, version: '2.261023.28' },
    { id: 'cli:work', url: 'https://omni.example.com', local: false, pairing: 'on' },
    { id: 'cli:old', url: 'http://127.0.0.1:8882', local: true, reachable: false },
  ]
  const plugins = { plugins: [{ name: 'a', title: 'Bot team' }, { name: 'b', title: 'Omni channels' }], install: { current: 'b', done: ['a'] } }
  const phases = {
    waking: null, installing: { plugins }, starting: { plugins }, looking: null, found: { omnis }, none: { sandbox: null },
    pairing: { pairing: { code: 'K7Q2-9M', origin: 'omni.example.com', waLink: 'https://wa.me/x' } }, linked: { origin: 'omni.example.com' }, restart: null, failed: { message: 'Bot team: offline' },
  }
  const outside = tree => outsideBox(tree).filter(node => typeof node.type === 'string').map(node => `${node.type}.${node.props.className ?? ''}`).join(' ')
  const awakeShape = outside(card('waking'))
  for (const [phase, detail] of Object.entries(phases)) {
    if (phase === 'failed') continue
    assert.equal(outside(card(phase, detail)), awakeShape, `${phase} changes the card outside the box`)
  }

  const installing = card('installing', phases.installing)
  assert.equal(textOf(findAll(installing, byClass('oai-status'))[0]), 'Installing Omni channels · 2 of 2')
  assert.deepEqual(findAll(installing, node => node.type === 'li' && /oai-install-/.test(node.props.className)).map(node => node.props.className), ['oai-install-done', 'oai-install-now'])
  assert.equal(findAll(installing, byClass('oai-power'))[0].props.disabled, true)
  assert.equal(textOf(findAll(card('starting', phases.starting), byClass('oai-status'))[0]), 'Starting Omni in this DSH…')

  const looking = card('looking')
  assert.equal(findAll(looking, byClass('oai-scan')).length, 1)
  assert.equal(textOf(findAll(looking, byClass('oai-status'))[0]), 'Looking for a connection…')

  const used = []
  const found = card('found', { omnis }, { use: omni => used.push(omni.id) })
  assert.equal(textOf(findAll(found, byClass('oai-status'))[0]), 'Found 2 Omnis')
  // Choices, not a form: each ready Omni, a new one here, one somewhere else.
  const tiles = tree => findAll(tree, byClass('oai-destiny-tile')).filter(node => node.type === 'button')
  const titles = tree => tiles(tree).map(node => textOf(findAll(node, node => node.type === 'strong')[0]))
  // No machine from the host and no page address here: the neutral name for DSH's machine.
  assert.deepEqual(titles(found), [
    'Use your Omni on the computer this workspace runs on',
    'Connect omni.example.com', 'An Omni somewhere else',
  ])
  tiles(found)[1].props.onClick()
  assert.deepEqual(used, ['cli:work'])
  assert.match(textOf(found), /Not answering right now/)
  assert.equal(findAll(found, node => node.type === 'input').length, 0)

  let local = 0
  const none = card('none', { sandbox: null }, { local: () => { local += 1 } })
  assert.equal(textOf(findAll(none, byClass('oai-status'))[0]), 'Where should Omni live?')
  assert.deepEqual(titles(none), ['Install Omni here', 'An Omni somewhere else'])
  assert.equal(findAll(none, node => node.type === 'input').length, 0, 'no address until "somewhere else" is chosen')
  tiles(none)[0].props.onClick()
  assert.equal(local, 1)
  assert.match(textOf(card('pairing', phases.pairing)), /K7Q2-9M/)
  assert.match(textOf(card('failed', phases.failed)), /Bot team: offline/)
})

test('the box lights wake one by one, then show what is true', () => {
  const state = phase => plain(team.lightsOf(phase)).map(([, value]) => value).join(' ')
  assert.equal(state('asleep'), 'off off off')
  assert.equal(state('installing'), 'on busy off')
  assert.equal(state('looking'), 'on on busy')
  assert.equal(state('linked'), 'on on on')
  assert.equal(state('failed'), 'on warn off')
  const css = ONBOARD_CSS
  assert.match(css, /\.oai-is-waking \.oai-light:nth-child\(3\)\{animation-delay:\.6s\}/)
  assert.match(css, /\.oai-box\{position:relative;height:340px/, 'the box has one fixed height')
})

test('a typed address or a link Omni sent reads the way the Connect Omni step reads it', () => {
  assert.deepEqual(plain(team.readRemote('https://omni.example.com/api/login/app?grant=abcdefghijklmnopqrstuvwx')), { kind: 'grant', url: 'https://omni.example.com', grant: 'abcdefghijklmnopqrstuvwx' })
  assert.deepEqual(plain(team.readRemote('omni://connect?url=https://omni.example.com&grant=abcdefghijklmnopqrstuvwx')), { kind: 'grant', url: 'https://omni.example.com', grant: 'abcdefghijklmnopqrstuvwx' })
  assert.deepEqual(plain(team.readRemote(' omni.example.com ')), { kind: 'address', url: 'omni.example.com' })
  assert.equal(team.readRemote('https://omni.example.com/?grant=short').kind, 'bad-link')
  assert.equal(team.readRemote('  '), null)
  // The claim link an Omni nobody owns prints in its log: its address, and the page to open.
  assert.deepEqual(plain(team.readRemote('http://100.64.0.10:8882/api/login/claim?token=example-claim-token')), { kind: 'claim', url: 'http://100.64.0.10:8882', claimUrl: 'http://100.64.0.10:8882/api/login/claim?token=example-claim-token' })
  assert.equal(team.readRemote('http://100.64.0.10:8882/api/login/claim').kind, 'address')
  assert.deepEqual(plain(team.readRemote('http://100.64.0.10:8882')), { kind: 'address', url: 'http://100.64.0.10:8882' })
  assert.equal(team.channelLabel({ type: 'whatsapp-baileys' }), 'WhatsApp')
  assert.equal(team.foundChoice({ id: 'x', url: 'http://127.0.0.1:1', local: true, updateTo: '2.3.0' }).action, null)
})

// The desktop app opened for one product (AUTOMAGIK_PRELOAD): that card comes first and
// starts chosen; the other stays to add. No preload keeps Omni first and nothing chosen.
test('the preload orders the team and starts its product chosen', () => {
  assert.deepEqual(plain(team.teamOrder(null)), ['omni', 'genie'])
  assert.deepEqual(plain(team.teamOrder('omni')), ['omni', 'genie'])
  assert.deepEqual(plain(team.teamOrder('genie')), ['genie', 'omni'])
  assert.deepEqual(plain(team.preselected(null)), { omni: false, genie: false })
  assert.deepEqual(plain(team.preselected('omni')), { omni: true, genie: false })
  assert.deepEqual(plain(team.preselected('genie')), { omni: false, genie: true })
  // Omni powers on through its box, once, and never after the person switched it off.
  assert.equal(team.powersOnByItself('omni', 'asleep', null, false), true)
  assert.equal(team.powersOnByItself('omni', 'asleep', null, true), false)
  assert.equal(team.powersOnByItself('omni', 'asleep', { removed: true }, false), false)
  assert.equal(team.powersOnByItself('omni', 'looking', null, false), false)
  assert.equal(team.powersOnByItself('genie', 'asleep', null, false), false)
  // `genie desktop` powers Genie on the same way.
  assert.equal(team.powersOnByItself('genie', 'asleep', null, false, 'genie'), true)
  assert.equal(team.powersOnByItself('genie', 'asleep', { removed: true }, false, 'genie'), false)
  assert.equal(team.powersOnByItself('omni', 'asleep', null, false, 'genie'), false)
  assert.equal(team.powersOnByItself(null, 'asleep', null, false), false)
  assert.equal(team.joinedLabel({ omni: true, genie: false }, 'Mochi'), 'Continue with Omni')
  assert.equal(team.joinedLabel({ omni: true, genie: true }, 'Mochi'), 'Continue with Omni and Genie')
  assert.equal(team.joinedLabel({ omni: false, genie: true }, 'Mochi'), 'Continue with Genie')
  assert.equal(team.joinedLabel({ omni: false, genie: false }, 'Mochi'), 'Continue with just Mochi')
})

test('Omni\'s face in its box follows the phase: asleep, working, waiting for you, linked, failed', () => {
  const faces = Object.fromEntries(['asleep', 'waking', 'installing', 'starting', 'looking', 'found', 'none', 'pairing', 'restart', 'linked', 'failed'].map(phase => [phase, team.omniFaceOf(phase)]))
  assert.deepEqual(faces, { asleep: 'asleep', waking: 'focused', installing: 'focused', starting: 'focused', looking: 'focused', found: 'curious', none: 'curious', pairing: 'curious', restart: 'curious', linked: 'delighted', failed: 'sad' })
  assert.match(findAll(card('failed', { message: 'no network' }), byClass('oai-octo-wrap'))[0].props.dangerouslySetInnerHTML.__html, /data-face="sad"/)
})

test('Genie\'s face in its box follows the phase: asleep, working, on the team, waiting, failed', () => {
  const faces = Object.fromEntries(['asleep', 'waking', 'installing', 'starting', 'ready', 'restart', 'failed'].map(phase => [phase, team.genieExpressionOf(phase)]))
  assert.deepEqual(faces, { asleep: 'asleep', waking: 'focused', installing: 'focused', starting: 'focused', ready: 'delighted', restart: 'curious', failed: 'sad' })
})

// The welcome's genie-plugin answers, one per call, then the last again.
function genieHost(answers) {
  const calls = []
  const shown = []
  let at = 0
  const genieAi = async (endpoint) => {
    calls.push(endpoint)
    const answer = answers[Math.min(at++, answers.length - 1)]
    if (answer instanceof Error) throw answer
    return answer
  }
  const show = (phase, detail) => shown.push(detail === undefined || detail === null ? phase : [phase, detail])
  return { calls, shown, run: () => team.geniePowerOn({ show, genieAi, wait: async () => {}, quick: true }) }
}

test('Genie powers on: already here it is ready at once; else its plugin installs and starts, then it is ready', async () => {
  const bot = { id: 'g1', name: 'Genie' }
  const here = genieHost([{ ready: true, bot }])
  assert.equal(await here.run(), 'ready')
  assert.deepEqual(plain(here.shown), ['waking', ['ready', { bot }]])

  const fresh = genieHost([
    { ready: false, install: null },
    { ready: false, install: { phase: 'installing' } },
    { ready: false, install: { phase: 'installing' } },
    { ready: false, install: { phase: 'done' } },
    { ready: true, bot, install: { phase: 'done' } },
  ])
  assert.equal(await fresh.run(), 'ready')
  assert.deepEqual(plain(phases(fresh.shown)), ['waking', 'installing', 'installing', 'installing', 'starting', 'ready'])
  assert.deepEqual(plain(fresh.calls), ['genie-plugin', 'genie-plugin-install', 'genie-plugin', 'genie-plugin', 'genie-plugin'])
})

test('Genie\'s power on ends at failed with the reason, or at restart when its Bot never comes', async () => {
  const noGit = genieHost([{ ready: false, install: null }, { ready: false, install: { phase: 'failed', error: 'Genie needs Apple\'s command line tools. Open Terminal and run this one line: xcode-select --install. Then power Genie on again.' } }])
  assert.equal(await noGit.run(), 'failed')
  assert.match(noGit.shown.at(-1)[1].message, /xcode-select --install/)

  const refused = genieHost([{ ready: false, install: null }, new Error('This DSH has no plugin manager to install Genie with.')])
  assert.equal(await refused.run(), 'failed')

  const restart = genieHost([{ ready: false, install: null }, { ready: false, install: { phase: 'restart' } }])
  assert.equal(await restart.run(), 'restart')
  const never = genieHost([{ ready: false, install: null }, { ready: false, install: { phase: 'done' } }])
  assert.equal(await never.run(), 'restart')
  assert.equal(never.calls.length, 2 + team.READY_POLLS)
})

test('Genie\'s box says where it stands, and lights its plugin and its place on the team', () => {
  assert.equal(team.genieStatusOf('asleep'), 'Powered off')
  assert.equal(team.genieStatusOf('asleep', { removed: true }), 'Powered off · not on your team')
  assert.equal(team.genieStatusOf('ready'), 'Ready for a wish')
  assert.deepEqual(plain(team.genieLightsOf('ready')), [['power', 'on'], ['plugins', 'on'], ['team', 'on']])
  assert.deepEqual(plain(team.genieLightsOf('installing')), [['power', 'on'], ['plugins', 'busy'], ['team', 'off']])
  assert.deepEqual(plain(team.genieLightsOf('failed')), [['power', 'on'], ['plugins', 'warn'], ['team', 'off']])
})

test("'Install Omni here' shows the installer output in the card until linked", async () => {
  const calls = []
  const reads = [
    { state: 'running', step: 'download-bun', data: 'Downloading Bun…\r\n', next: 1 },
    { state: 'running', step: null, data: 'Installing @automagik/omni…\r\n', next: 2 },
    { state: 'exited', exitCode: 0, data: 'Linked.\r\n', next: 3, result: { status: 'paired', origin: 'http://127.0.0.1:8882', version: '2.261025.16' } },
  ]
  const omniUi = async (endpoint, payload) => {
    calls.push([endpoint, payload])
    if (endpoint === 'omni-terminal-open') return { terminal: 't1', state: 'ready', command: 'bun x --bun @automagik/omni install --sandbox --at-login' }
    if (endpoint === 'omni-terminal-read') return reads.shift()
    if (endpoint === 'omni-terminal-write') return { ok: true }
    return {}
  }
  const shown = []
  const last = await team.sandboxInstall({ show: (phase, detail) => shown.push([phase, plain(detail)]), omniUi, wait: async () => {} })
  assert.equal(last, 'linked')
  assert.deepEqual(calls.map(([endpoint]) => endpoint), ['omni-terminal-open', 'omni-terminal-write', 'omni-terminal-read', 'omni-terminal-read', 'omni-terminal-read', 'omni-terminal-close'])
  assert.deepEqual(plain(calls[1][1]), { terminal: 't1', data: '\r' })
  assert.deepEqual(calls.filter(([endpoint]) => endpoint === 'omni-terminal-read').map(([, payload]) => payload.from), [0, 1, 2])
  assert.deepEqual(shown.at(-2), ['sandbox', { terminal: 't1', log: 'Downloading Bun…\r\nInstalling @automagik/omni…\r\n', step: null }])
  assert.deepEqual(shown.at(-1), ['linked', { origin: 'http://127.0.0.1:8882' }])
  assert.equal(team.statusOf('sandbox', { step: 'download-bun' }), 'Downloading Bun for Omni…')
})

test('Omni waits for terminal preparation before sending Enter and never resends an accepted start', async () => {
  const calls = []
  const reads = [
    { state: 'preparing', step: 'download-bun', data: '', next: 0 },
    { state: 'ready', step: null, data: '~ $ install Omni', next: 16 },
    { state: 'ready', step: null, data: '\r\nInstalling…', next: 29 },
    { state: 'done', exitCode: 0, result: { status: 'paired', origin: 'http://localhost:8882' } },
  ]
  let ready = false
  const shown = []
  const omniUi = async (endpoint, payload) => {
    calls.push([endpoint, plain(payload)])
    if (endpoint === 'omni-terminal-open') return { terminal: 'preparing', state: 'preparing' }
    if (endpoint === 'omni-terminal-read') {
      const value = reads.shift()
      assert.ok(value, 'polling must end after the install')
      ready = value.state === 'ready'
      return value
    }
    if (endpoint === 'omni-terminal-write') {
      assert.equal(ready, true, 'Enter before ready is discarded by the host')
      return { ok: true }
    }
    return {}
  }
  assert.equal(await team.sandboxInstall({ show: (...entry) => shown.push(plain(entry)), omniUi, wait: async () => {} }), 'linked')
  assert.deepEqual(calls.map(([endpoint]) => endpoint), ['omni-terminal-open', 'omni-terminal-read', 'omni-terminal-read', 'omni-terminal-write', 'omni-terminal-read', 'omni-terminal-read', 'omni-terminal-close'])
  assert.deepEqual(calls.find(([endpoint]) => endpoint === 'omni-terminal-write')[1], { terminal: 'preparing', data: '\r' })
  assert.ok(shown.some(([phase, detail]) => phase === 'sandbox' && detail.step === 'download-bun'))
})

test('Omni retries an unaccepted Enter after readiness is reported again', async () => {
  const reads = [
    { state: 'preparing', step: 'download-bun' },
    { state: 'ready' },
    { state: 'ready' },
    { state: 'done', exitCode: 0 },
  ]
  let writes = 0
  const omniUi = async endpoint => {
    if (endpoint === 'omni-terminal-open') return { terminal: 'retry', state: 'ready' }
    if (endpoint === 'omni-terminal-write') return { ok: ++writes > 1 }
    if (endpoint === 'omni-terminal-read') {
      const value = reads.shift()
      assert.ok(value, 'polling must end after the install')
      return value
    }
    return {}
  }
  assert.equal(await team.sandboxInstall({ show: () => {}, omniUi, wait: async () => {} }), 'linked')
  assert.equal(writes, 2)
})

test('failed or cancelled terminal preparation never sends Enter', async () => {
  for (const cancelled of [false, true]) {
    const calls = []
    const signal = { aborted: false }
    const shown = []
    const omniUi = async endpoint => {
      calls.push(endpoint)
      if (endpoint === 'omni-terminal-open') return { terminal: 'never-start', state: 'preparing' }
      if (endpoint === 'omni-terminal-read') {
        if (cancelled) { signal.aborted = true; return { state: 'ready' } }
        return { state: 'failed', error: 'Bun download failed' }
      }
      return { ok: true }
    }
    const run = team.sandboxInstall({ show: (...entry) => shown.push(plain(entry)), signal, omniUi, wait: async () => {} })
    if (cancelled) await assert.rejects(run, { name: 'AbortError' })
    else {
      assert.equal(await run, 'failed')
      assert.deepEqual(shown.at(-1), ['failed', { message: 'Bun download failed', log: '' }])
      assert.ok(calls.includes('omni-terminal-close'))
    }
    assert.equal(calls.includes('omni-terminal-write'), false)
  }
})

test("a failed install keeps what Omni's installer printed on the card", async () => {
  const omniUi = async (endpoint) => (endpoint === 'omni-terminal-open' ? { terminal: 't2' } : endpoint === 'omni-terminal-read' ? { state: 'exited', exitCode: 1, data: 'error: no space left\r\n', next: 1 } : {})
  const shown = []
  assert.equal(await team.sandboxInstall({ show: (phase, detail) => shown.push([phase, plain(detail)]), omniUi, wait: async () => {} }), 'failed')
  assert.deepEqual(shown.at(-1), ['failed', { message: "Omni's installer stopped (exit code 1). What it printed is above.", log: 'error: no space left\r\n' }])
})

test('an Omni nobody owns yet is told apart, with the command that connects it', () => {
  assert.equal(team.isUnowned('100.64.0.10:8882 has no owner yet. Claim it first with the link in its server log.'), true)
  assert.equal(team.isUnowned('Omni answered 500 at omni.example.com'), false)
  assert.equal(team.isUnowned(undefined), false)
  assert.equal(team.connectCommand('http://100.64.0.10:8882'), 'omni connect --url http://100.64.0.10:8882')
})

test('the machine DSH reports reaches the new-Omni tile, through the step and the card', async () => {
  // A page on loopback in a Mac browser: the tile names DSH's own OS, not the viewer's.
  const gated = []
  const paged = await load('team.js', { scope: { location: { hostname: 'localhost' }, navigator: { platform: 'MacIntel' } }, gated })
  const runTile = machine => textOf(findAll(render(paged.OmniCard({ power: { phase: 'none', detail: { omnis: [] }, busy: null, problem: null, use: () => {}, remote: () => {}, local: () => {}, cancelPairing: () => {}, machine }, onPower: () => {}, type: omniType, abilities: {}, onToggle: () => {}, live: null })), byClass('oai-destiny-sandbox'))[0])
  assert.equal(runTile({ os: 'linux' }),
    'Install Omni hereOn the computer this workspace runs on')
  assert.equal(runTile({ os: 'macos' }), 'Install Omni hereOn this Mac')
  // The step hands the gate state's machine to Omni's card.
  const machine = { os: 'linux', remoteHint: true }
  gated.push({ machine, preload: null })
  const step = paged.TeamStep({ stepId: 'omni-team', complete: () => {}, openSection: () => {} })
  const [omniCard] = findAll(step, node => node.type === paged.OmniCard)
  assert.equal(omniCard.props.power.machine, machine)
})
