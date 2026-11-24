// Claude Code and Codex in Connect AI and in Settings: the host's acp endpoints over acp-dsh's
// acpAgents service (or none), and every state a row can show, in English and in pt-BR.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { Buffer } from 'node:buffer'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { STAGE_CSS } from '../src/client/octopus.js'
import { install } from '../src/host/endpoint.js'
import { ACP_ENTRY, agentView } from '../src/host/acp.js'
import { fakeContext } from './fake-ctx.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))

// ---- The host -------------------------------------------------------------------------------

// acp-dsh's service as its status() answers, with what a call did.
function fakeAcp(agents, { settingsEntry } = {}) {
  const calls = []
  const service = {
    ...(settingsEntry === undefined ? {} : { settingsEntry }),
    status: async () => { calls.push('status'); return { agents: structuredClone(agents) } },
    refresh: async () => { calls.push('refresh'); return { agents: structuredClone(agents) } },
    retry: async (id) => { calls.push(['retry', id]); return { agents: structuredClone(agents) } },
  }
  return { service, calls }
}
const agent = (id, over = {}) => ({
  id,
  key: id === 'acp-claude' ? 'claude' : 'codex',
  name: id === 'acp-claude' ? 'Claude Code' : 'Codex',
  on: true,
  cli: { found: true, installUrl: 'https://example.com/install' },
  connector: { state: 'ready', version: '1.2.3' },
  signedIn: true,
  model: { provider: id, id: 'default', name: 'x', listed: true },
  restartNeeded: false,
  ...over,
})

function host({ acp, entries = { 'omni-ai': {}, [ACP_ENTRY]: { claude: true, codex: true } } } = {}) {
  const fake = fakeContext({ entries, services: acp ? { acpAgents: acp.service } : {} })
  const { handle } = install(fake.ctx)
  return { ...fake, handle }
}

test('without acp-dsh the acp endpoint answers unavailable, and nothing else is touched', async () => {
  const fake = host()
  assert.deepEqual(await fake.handle('acp', { refresh: true }), { ok: true, value: { available: false, agents: [] } })
  const reply = await fake.handle('acp-switch', { id: 'acp-claude', on: true })
  assert.equal(reply.ok, false)
  assert.equal(reply.error.code, 'omni-ai/refused')
  assert.deepEqual(fake.updates, [])
})

test('the status passes through what the page draws, refreshed only when asked', async () => {
  const acp = fakeAcp([agent('acp-claude', { extra: 'x', cli: { found: true, installUrl: 'javascript:alert(1)' } }), agent('acp-codex', { connector: { state: 'failed', error: 'npm answered 503' }, signedIn: undefined }), agent('acp-gemini')])
  const fake = host({ acp })
  const { value } = await fake.handle('acp')
  assert.deepEqual(acp.calls, ['status'])
  assert.equal(value.available, true)
  assert.deepEqual(value.agents.map(row => row.id), ['acp-claude', 'acp-codex'])
  // Only an https install link reaches the page; nothing it does not draw.
  assert.deepEqual(value.agents[0].cli, { found: true })
  assert.equal('extra' in value.agents[0], false)
  assert.deepEqual(value.agents[1].connector, { state: 'failed', error: 'npm answered 503' })
  assert.equal('signedIn' in value.agents[1], false)
  await fake.handle('acp', { refresh: true })
  assert.deepEqual(acp.calls, ['status', 'refresh'])
})

test("a switch writes acp-dsh's own setting under its key, at the revision it read", async () => {
  const acp = fakeAcp([agent('acp-claude'), agent('acp-codex', { on: false })])
  const fake = host({ acp })
  const on = await fake.handle('acp-switch', { id: 'acp-codex', on: true })
  assert.equal(on.ok, true)
  assert.deepEqual(fake.updates, [{ ns: 'acp-dsh', patch: { codex: true }, expectedRevision: 3 }])
  // Turned on: the CLI and its sign-in are looked at again.
  assert.equal(acp.calls.at(-1), 'refresh')
  await fake.handle('acp-switch', { id: 'acp-claude', on: false })
  assert.deepEqual(fake.updates.at(-1), { ns: 'acp-dsh', patch: { claude: false }, expectedRevision: 4 })
  assert.equal(acp.calls.at(-1), 'status')
  for (const bad of [{ id: 'acp-gemini', on: true }, { id: 'acp-claude' }, { id: 'acp-claude', on: 'yes' }, null]) {
    const reply = await fake.handle('acp-switch', bad)
    assert.equal(reply.error.code, 'omni-ai/invalid')
  }
  assert.equal(fake.updates.length, 2)
})

test('a switch writes to the settings entry acp-dsh names as its own', async () => {
  const acp = fakeAcp([agent('acp-claude')], { settingsEntry: 'acp-dsh-work' })
  const fake = host({ acp, entries: { 'omni-ai': {}, [ACP_ENTRY]: { claude: true }, 'acp-dsh-work': { claude: true } } })
  const reply = await fake.handle('acp-switch', { id: 'acp-claude', on: false })
  assert.equal(reply.ok, true)
  assert.deepEqual(fake.updates, [{ ns: 'acp-dsh-work', patch: { claude: false }, expectedRevision: 3 }])
})

test('a DSH without the acp-dsh settings entry refuses the switch in words', async () => {
  const acp = fakeAcp([agent('acp-claude')])
  const fake = host({ acp, entries: { 'omni-ai': {} } })
  const reply = await fake.handle('acp-switch', { id: 'acp-claude', on: false })
  assert.equal(reply.error.code, 'omni-ai/refused')
  assert.match(reply.error.message, /cannot change/)
})

test('retry asks acp-dsh to install the connector again', async () => {
  const acp = fakeAcp([agent('acp-codex', { connector: { state: 'failed', error: 'x' } })])
  const fake = host({ acp })
  const reply = await fake.handle('acp-retry', { id: 'acp-codex' })
  assert.equal(reply.ok, true)
  assert.deepEqual(acp.calls, [['retry', 'acp-codex']])
})

test('an unknown connector state from a newer acp-dsh reads as installing', () => {
  assert.equal(agentView(agent('acp-claude', { connector: { state: 'warming' } })).connector.state, 'installing')
})

test('the CLI\'s own state reaches the page, redacted, and nothing it does not draw', async () => {
  const token = ['ghp_', 'a'.repeat(24)].join('')
  const raw = agent('acp-claude', { cli: {
    found: false, state: 'failed', version: '2.1.319', updating: true, managed: true,
    error: `download failed: Bearer ${token}`, diagnostic: `NPM_TOKEN=${token}`,
    logPath: join(homedir(), '.automagik', 'acp', 'clis', 'logs', 'claude.log'),
    privateCommand: '/private/cli',
  } })
  const { value } = await host({ acp: fakeAcp([raw]) }).handle('acp')
  const cli = value.agents[0].cli
  assert.equal(cli.state, 'failed')
  assert.equal(cli.version, '2.1.319')
  assert.equal(cli.updating, true)
  assert.equal(cli.found, false)
  assert.ok(!JSON.stringify(cli).includes(token))
  assert.ok(!JSON.stringify(cli).includes(homedir()))
  assert.match(cli.logPath, /^~[/\\]/)
  assert.equal(cli.privateCommand, undefined)
  assert.equal(cli.managed, undefined)
  assert.equal(agentView(agent('acp-codex', { cli: { found: true, state: 'unknown' } })).cli.state, undefined)
})

// ---- The page -------------------------------------------------------------------------------

const bundle = await build({
  stdin: { contents: "export * from './src/client/acp-agents.js'\nexport { installLocale, PT_BR } from './src/client/i18n.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
})
// Stateless hooks for drawing a row once; runHook below swaps in ones that keep state.
const stateless = {
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {}, useRef: current => ({ current }), useCallback: fn => fn,
}
let hooks = stateless
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => hooks.useState(initial),
  useEffect: (effect, deps) => hooks.useEffect(effect, deps),
  useRef: current => hooks.useRef(current),
  useCallback: (fn, deps) => hooks.useCallback(fn, deps),
}
const client = { exports: {} }
const sandbox = { module: client, exports: client.exports, setTimeout, clearTimeout, setInterval, clearInterval, require: name => ({ react, 'react-dom': {} })[name] }
runInNewContext(bundle.outputFiles[0].text, sandbox)
const ui = client.exports

// A hook run the way React runs it: state kept by call order, a render after each update,
// and effects run after the render when their dependencies change. `intervals` counts the
// polling timers alive.
function runHook(hook) {
  const slots = []
  const intervals = new Set()
  let index = 0
  let result
  let queued = false
  const same = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  let effects = []
  const own = {
    useState(initial) {
      const i = index++
      if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[i]
      slot.set ??= (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
        if (!queued) { queued = true; queueMicrotask(draw) }
      }
      return [slot.value, slot.set]
    },
    useRef(current) {
      const i = index++
      slots[i] ??= { current }
      return slots[i]
    },
    useCallback(fn, deps) {
      const i = index++
      if (!(i in slots) || !same(slots[i].deps, deps)) slots[i] = { fn, deps }
      return slots[i].fn
    },
    useEffect(effect, deps) {
      const i = index++
      const slot = slots[i] ?? (slots[i] = {})
      if (slot.deps === undefined || !same(slot.deps, deps)) effects.push(() => { slot.cleanup?.(); slot.deps = deps; slot.cleanup = effect() })
    },
  }
  function draw() {
    queued = false
    index = 0
    effects = []
    hooks = own
    try { result = hook() } finally { hooks = stateless }
    for (const run of effects) run()
  }
  const realSet = sandbox.setInterval
  const realClear = sandbox.clearInterval
  sandbox.setInterval = (fn, ms) => { const timer = realSet(fn, ms); intervals.add(timer); return timer }
  sandbox.clearInterval = (timer) => { intervals.delete(timer); realClear(timer) }
  draw()
  return {
    get current() { return result },
    intervals,
    settle: () => new Promise(done => setImmediate(done)),
    done() {
      for (const slot of slots) slot?.cleanup?.()
      for (const timer of intervals) realClear(timer)
      sandbox.setInterval = realSet
      sandbox.clearInterval = realClear
    },
  }
}

function render(node) {
  if (Array.isArray(node)) return node.map(render)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }))
  return { ...node, children: node.children.map(render) }
}
const textOf = node => (Array.isArray(node) ? node.map(textOf).join('') : node === null || node === undefined || node === false ? '' : typeof node === 'object' ? textOf(node.children) : String(node))
function findAll(node, match, out = []) {
  if (Array.isArray(node)) node.forEach(child => findAll(child, match, out))
  else if (node && typeof node === 'object') {
    if (match(node)) out.push(node)
    findAll(node.children, match, out)
  }
  return out
}
const view = agents => ({ available: true, agents: agents.map(agentView) })
const acpOf = (agents, over = {}) => {
  const acted = []
  return { acted, view: view(agents), busy: null, problems: {}, isOn: row => row.on, flip: row => acted.push(['flip', row.id]), retry: row => acted.push(['retry', row.id]), check: row => acted.push(['check', row.id]), login: row => acted.push(['login', row.id]), ...over }
}
const rowOf = (row, acp = acpOf([row])) => render(ui.AcpAgentRow({ agent: agentView(row), acp }))
const buttons = (tree, label) => findAll(tree, node => node.type === 'button' && textOf(node) === label)

test('no CLI: the row says so, links its install page, and checks again on request', () => {
  const acp = acpOf([])
  const tree = rowOf(agent('acp-claude', { cli: { found: false, installUrl: 'https://code.claude.com/docs/en/setup' }, connector: { state: 'no-cli' }, signedIn: undefined }), acp)
  assert.match(textOf(tree), /Not installed/)
  assert.match(textOf(tree), /The claude CLI is not on this computer/)
  const [link] = findAll(tree, node => node.type === 'a')
  assert.equal(link.props.href, 'https://code.claude.com/docs/en/setup')
  assert.equal(textOf(link), 'Install Claude Code')
  buttons(tree, 'Check again')[0].props.onClick()
  assert.deepEqual(acp.acted, [['check', 'acp-claude']])
  assert.equal(tree.props['data-state'], 'no-cli')
})

test('installing: the connector is said to be on its way, with no retry', () => {
  const tree = rowOf(agent('acp-codex', { connector: { state: 'installing' }, signedIn: undefined }))
  assert.match(textOf(tree), /Setting up/)
  assert.match(textOf(tree), /Installing its connector in the background/)
  assert.deepEqual(buttons(tree, 'Retry'), [])
  assert.equal(findAll(tree, node => /oai-waiting/.test(node.props?.className ?? '')).length, 1)
})

test('the client redactor alone removes every shared shape', () => {
  const user = ['deploy', 'bot'].join('')
  const pass = ['secret', 'pass'].join('')
  const auth = Buffer.from([user, pass].join(':')).toString('base64')
  const url = ['https://', user, ':', pass, '@registry.npmjs.org/pkg'].join('')
  const npmToken = ['npm_', 'a'.repeat(24)].join('')
  const skToken = ['sk-', 'b'.repeat(12)].join('')
  const ghToken = ['ghp_', 'c'.repeat(24)].join('')
  const nodeToken = 'node-auth-secret'
  const myToken = 'my-npm-secret'
  const jsonToken = 'json-npm-secret'
  const secrets = [
    npmToken,
    auth,
    pass,
    skToken,
    ghToken,
    'abcdefgh12345678',
    'abcdef123456',
    'quoted-secret-123456',
    'quoted-auth-secret==',
    'env-token-secret',
    'npm-config-secret',
    nodeToken,
    myToken,
    jsonToken,
  ]
  const raw = [
    npmToken,
    `_authToken=${auth}`,
    url,
    skToken,
    ghToken,
    'Bearer abcdefgh12345678',
    '?token=abcdef123456',
    '"_authToken": "quoted-secret-123456"',
    '"//registry.npmjs.org/:_auth": "quoted-auth-secret=="',
    'NPM_TOKEN=env-token-secret',
    'npm_config__authToken=npm-config-secret',
    `NODE_AUTH_TOKEN=${nodeToken}`,
    `MY_NPM_TOKEN=${myToken}`,
    `{"NPM_TOKEN": "${jsonToken}"}`,
  ].join(' ')
  const text = ui.redactText(raw)
  for (const value of secrets) assert.ok(!text.includes(value), `hides ${value}`)
  assert.match(text, /npm_\[hidden\]/)
  assert.match(text, /_authToken=\[hidden\]/)
  assert.match(text, /\[hidden\]@registry\.npmjs\.org/)
  assert.match(text, /Bearer \[hidden\]/)
  assert.match(text, /NODE_AUTH_TOKEN=\[hidden\]/)
  assert.match(text, /MY_NPM_TOKEN=\[hidden\]/)
  assert.match(text, /"NPM_TOKEN": \[hidden\]/)
})

test('the row redacts a token and shows a home-relative log path', () => {
  const home = homedir()
  const token = ['ghp_', 'a'.repeat(24)].join('')
  const tree = rowOf(agent('acp-codex', { connector: { state: 'failed', error: 'npm answered 503', diagnostic: `token=${token}`, logPath: join(home, '.automagik', 'acp', 'adapters', 'logs', 'codex.log') } }), acpOf([]))
  const text = textOf(tree)
  assert.ok(!text.includes(token), 'the token is redacted in the row')
  assert.match(text, /Log: ~\/\.automagik\/acp\/adapters\/logs\/codex\.log/)
})

test('npm credentials and an absolute home are redacted in the answer and the row', async () => {
  const npmToken = ['npm_', 'a'.repeat(24)].join('')
  const user = ['deploy', 'bot'].join('')
  const pass = ['secret', 'pass'].join('')
  const auth = Buffer.from([user, pass].join(':')).toString('base64')
  const url = ['https://', user, ':', pass, '@registry.npmjs.org/pkg'].join('')
  const homeLog = `${homedir()}/.npm/_logs/2026-11-06T00_00_00_000Z-debug-0.log`
  const quoted = 'quoted-secret-123456'
  const nodeToken = 'node-auth-secret'
  const myToken = 'my-npm-secret'
  const jsonToken = 'json-npm-secret'
  const diagnostic = `npm ERR! token ${npmToken}\nnpm ERR! _authToken=${auth}\nnpm ERR! fetch ${url}\nnpm ERR! path ${homeLog}\n{"_authToken": "${quoted}"}\nNPM_TOKEN=env-token-secret\nNODE_AUTH_TOKEN=${nodeToken}\nMY_NPM_TOKEN=${myToken}\n{"NPM_TOKEN": "${jsonToken}"}`
  const acp = fakeAcp([agent('acp-codex', { connector: { state: 'failed', error: `_authToken=${auth} {"_authToken": "${quoted}"} ${url} NODE_AUTH_TOKEN=${nodeToken} {"NPM_TOKEN": "${jsonToken}"}`, diagnostic } })])
  const fake = host({ acp })
  const { value } = await fake.handle('acp')
  const connector = value.agents[0].connector
  const text = textOf(rowOf(value.agents[0], acpOf([])))
  for (const raw of [npmToken, auth, pass, homedir(), quoted, 'env-token-secret', nodeToken, myToken, jsonToken]) {
    assert.ok(!connector.error.includes(raw), `the error hides ${raw}`)
    assert.ok(!connector.diagnostic?.includes(raw), `the diagnostic hides ${raw}`)
    assert.ok(!text.includes(raw), `the row hides ${raw}`)
  }
  assert.match(connector.diagnostic, /~\/\.npm\/_logs\//)
})

test('a connector error is redacted before it reaches the page', async () => {
  const skToken = ['sk-', 'b'.repeat(12)].join('')
  const acp = fakeAcp([agent('acp-codex', { connector: { state: 'failed', error: `${skToken} Bearer abcdefgh12345678` } })])
  const fake = host({ acp })
  const { value } = await fake.handle('acp')
  const error = value.agents[0].connector.error
  assert.ok(!error.includes(skToken), 'the token is not sent to the page')
  assert.ok(!error.includes('abcdefgh12345678'), 'the bearer value is not sent to the page')
  assert.match(error, /sk-\[hidden\]/)
  assert.match(error, /Bearer \[hidden\]/)
  // The row drawn from that answer carries the redacted error, not the raw one.
  const text = textOf(rowOf(value.agents[0], acpOf([])))
  assert.ok(!text.includes(skToken) && !text.includes('abcdefgh12345678'), 'the row drawn from the answer is redacted')
})

test('a row never prints a credential-shaped error even if one arrives unredacted', () => {
  const skToken = ['sk-', 'b'.repeat(12)].join('')
  const tree = rowOf(agent('acp-codex', { connector: { state: 'failed', error: `${skToken} Bearer abcdefgh12345678` } }), acpOf([]))
  const text = textOf(tree)
  assert.ok(!text.includes(skToken), 'the token is not drawn')
  assert.ok(!text.includes('abcdefgh12345678'), 'the bearer value is not drawn')
  assert.match(text, /sk-\[hidden\]/)
  assert.match(text, /Bearer \[hidden\]/)
})

// The client's own gate: the host strips credentials before it answers, and the panel applies
// the same shared table to the diagnostic it draws, without the host in the path.
const rawRowOf = (row, acp = acpOf([])) => render(ui.AcpAgentRow({ agent: row, acp }))

test('a row redacts a credential-shaped install diagnostic even if one arrives unredacted', () => {
  const npmToken = ['npm_', 'a'.repeat(24)].join('')
  const ghToken = ['ghp_', 'b'.repeat(24)].join('')
  const diagnostic = `npm ERR! ${npmToken}\nnpm ERR! https://deploybot:secretpass@registry.npmjs.org/pkg\nnpm ERR! ${ghToken}`
  const tree = rawRowOf(agent('acp-codex', { connector: { state: 'failed', error: 'npm answered 503', diagnostic } }))
  const text = textOf(tree)
  for (const raw of [npmToken, 'secretpass', ghToken]) assert.ok(!text.includes(raw), `the diagnostic hides ${raw}`)
  assert.match(text, /npm_\[hidden\]/)
  assert.match(text, /\[hidden\]@registry\.npmjs\.org/)
})

test('failed with a diagnostic: Install details carries the output and the log path unchanged', () => {
  const diagnostic = 'npm ERR! 503 Service Unavailable\nnpm ERR! failed'
  const tree = rowOf(agent('acp-codex', { connector: { state: 'failed', error: 'npm answered 503', diagnostic, logPath: '/tmp/acp/logs/codex.log' } }), acpOf([]))
  const text = textOf(tree)
  assert.match(text, /Install details/)
  const [pre] = findAll(tree, node => node.type === 'pre')
  assert.equal(textOf(pre), diagnostic)
  assert.match(text, /Log: \/tmp\/acp\/logs\/codex\.log/)
})

test('failed: the last error and a Retry that reinstalls', () => {
  const acp = acpOf([])
  const tree = rowOf(agent('acp-codex', { connector: { state: 'failed', error: 'npm answered 503' } }), acp)
  assert.match(textOf(tree), /Needs a retry/)
  assert.match(textOf(tree), /The connector did not install: npm answered 503/)
  buttons(tree, 'Retry')[0].props.onClick()
  assert.deepEqual(acp.acted, [['retry', 'acp-codex']])
})

test('ready and signed in: where to find it in the model picker', () => {
  const tree = rowOf(agent('acp-claude'))
  const text = textOf(tree)
  assert.match(text, /Ready/)
  assert.match(text, /Found the claude CLI on this computer/)
  assert.match(text, /Signed in to Claude Code/)
  assert.match(text, /Connector ready \(version 1\.2\.3\)/)
  assert.match(text, /Ready: pick Claude Code in the model picker/)
  const [toggle] = findAll(tree, node => node.props?.role === 'switch')
  assert.equal(toggle.props['aria-checked'], 'true')
})

test('signed out: Sign in opens a Bot chat, the terminal stays the other way, and no field asks for credentials', () => {
  const acp = acpOf([])
  const tree = rowOf(agent('acp-codex', { signedIn: false }), acp)
  assert.equal(tree.props['data-state'], 'login-required')
  assert.match(textOf(tree), /Sign-in needed/)
  assert.match(textOf(tree), /Not signed in to Codex\. Sign in from a Bot's chat\./)
  assert.match(textOf(tree), /Or run codex login in a terminal, then check again\./)
  assert.doesNotMatch(textOf(tree), /Ready: pick/)
  assert.deepEqual(findAll(tree, node => node.type === 'input'), [])
  buttons(tree, 'Sign in')[0].props.onClick()
  buttons(tree, 'Check again')[0].props.onClick()
  assert.deepEqual(acp.acted, [['login', 'acp-codex'], ['check', 'acp-codex']])
  assert.match(textOf(rowOf(agent('acp-claude', { signedIn: false }))), /Or run claude auth login in a terminal/)
})

test('signed in, or not checked yet: no Sign in button', () => {
  assert.deepEqual(buttons(rowOf(agent('acp-codex')), 'Sign in'), [])
  const unknown = rowOf(agent('acp-codex', { signedIn: undefined }))
  assert.deepEqual(buttons(unknown, 'Sign in'), [])
  assert.equal(unknown.props['data-state'], 'sign-in-unknown')
  assert.match(textOf(unknown), /Check sign-in/)
  assert.match(textOf(unknown), /The sign-in to Codex has not been checked yet/)
  assert.doesNotMatch(textOf(unknown), /Ready: pick/)
})

test('a CLI installing, updating or failed says so, and offers no sign-in meanwhile', () => {
  const installing = rowOf(agent('acp-claude', { on: false, cli: { found: false, state: 'installing' }, connector: { state: 'off' }, signedIn: undefined }))
  assert.equal(installing.props['data-state'], 'installing')
  assert.match(textOf(installing), /Installing Claude Code automatically/)
  assert.doesNotMatch(textOf(installing), /Not installed|Install it, sign in/)
  const updating = rowOf(agent('acp-codex', { cli: { found: true, state: 'ready', version: '0.167.0', updating: true }, signedIn: false }))
  assert.equal(updating.props['data-state'], 'updating')
  assert.match(textOf(updating), /Updating Codex automatically/)
  assert.match(textOf(updating), /version 0\.167\.0/)
  assert.deepEqual(buttons(updating, 'Sign in'), [])
  const acp = acpOf([])
  const failed = rowOf(agent('acp-claude', { cli: { found: false, error: 'download failed' }, signedIn: undefined }), acp)
  assert.equal(failed.props['data-state'], 'failed')
  assert.match(textOf(failed), /Needs a retry/)
  assert.match(textOf(failed), /installation or update failed: download failed/)
  buttons(failed, 'Retry')[0].props.onClick()
  assert.deepEqual(acp.acted, [['retry', 'acp-claude']])
})

test('a found CLI whose update failed still runs: Ready or Sign in, with the Retry line', () => {
  const acp = acpOf([])
  const stale = rowOf(agent('acp-claude', { cli: { found: true, state: 'ready', version: '2.1.319', error: 'registry unreachable' } }), acp)
  assert.equal(stale.props['data-state'], 'ready')
  assert.match(textOf(stale), /installation or update failed: registry unreachable/)
  assert.match(textOf(stale), /Ready: pick Claude Code in the model picker/)
  buttons(stale, 'Retry')[0].props.onClick()
  assert.deepEqual(acp.acted, [['retry', 'acp-claude']])
  const signedOut = rowOf(agent('acp-codex', { cli: { found: true, state: 'ready', version: '0.167.0', error: 'registry unreachable' }, signedIn: false }))
  assert.equal(signedOut.props['data-state'], 'login-required')
  assert.equal(buttons(signedOut, 'Sign in').length, 1)
  assert.equal(buttons(signedOut, 'Retry').length, 1)
})

test('the bridge takes only the two CLIs, and a missing or refusing bridge is a no', () => {
  const opened = []
  const scope = { [ui.CHAT_LOGIN]: { open: (provider) => { opened.push(provider); return true } } }
  assert.equal(ui.CHAT_LOGIN, Symbol.for('automagik.cli-login'))
  assert.equal(ui.openChatLogin('acp-codex', scope), true)
  assert.equal(ui.openChatLogin('acp-claude', scope), true)
  assert.equal(ui.openChatLogin('openai-codex', scope), false)
  assert.equal(ui.openChatLogin('__proto__', scope), false)
  assert.deepEqual(opened, ['acp-codex', 'acp-claude'])
  assert.equal(ui.openChatLogin('acp-codex', {}), false)
  assert.equal(ui.openChatLogin('acp-codex', { [ui.CHAT_LOGIN]: { open: () => { throw new Error('x') } } }), false)
})

test('login asks nothing of the host, and tells the page only when a chat took it', async () => {
  const calls = []
  const row = agentView(agent('acp-codex', { signedIn: false }))
  const request = async (endpoint) => { calls.push(endpoint); return { available: true, agents: [row] } }
  let answer = false
  const shown = []
  const run = runHook(() => ui.useAcp(request, { open: () => answer, onLoginOpen: agent => shown.push(agent.id) }))
  try {
    await run.settle()
    const before = [...calls]
    assert.equal(run.current.login(row), false)
    await run.settle()
    assert.deepEqual(shown, [])
    assert.match(run.current.problems['acp-codex'], /Run codex login in a terminal instead/)
    answer = true
    assert.equal(run.current.login(row), true)
    await run.settle()
    assert.deepEqual(shown, ['acp-codex'])
    assert.equal(run.current.problems['acp-codex'], null)
    assert.deepEqual(calls, before)
  } finally {
    run.done()
  }
})

test('Settings closes its panel once a Bot chat took the sign-in', async () => {
  let closed = 0
  const row = agent('acp-codex', { signedIn: false })
  sandbox.fetch = async () => ({ ok: true, json: async () => ({ ok: true, value: { available: true, agents: [agentView(row)] } }) })
  sandbox[ui.CHAT_LOGIN] = { open: provider => provider === 'acp-codex' }
  const run = runHook(() => ui.AcpSettingsSection({ close: () => { closed++ } }))
  try {
    await run.settle()
    buttons(render(run.current), 'Sign in')[0].props.onClick()
    assert.equal(closed, 1)
  } finally {
    delete sandbox[ui.CHAT_LOGIN]
    delete sandbox.fetch
    run.done()
  }
})

test('ready but missing from the picker: a plain restart note', () => {
  const text = textOf(rowOf(agent('acp-claude', { restartNeeded: true, model: { listed: false } })))
  assert.match(text, /Restart needed/)
  assert.match(text, /Restart DSH to see Claude Code in the model picker/)
  assert.doesNotMatch(text, /Ready: pick/)
})

test('off: the switch is off and flipping it asks for the setting', () => {
  const acp = acpOf([])
  const tree = rowOf(agent('acp-claude', { on: false, connector: { state: 'off' } }), acp)
  assert.match(textOf(tree), /Off\. Turn it on to use Claude Code/)
  const [toggle] = findAll(tree, node => node.props?.role === 'switch')
  assert.equal(toggle.props['aria-checked'], 'false')
  toggle.props.onClick()
  assert.deepEqual(acp.acted, [['flip', 'acp-claude']])
})

test('a refused switch goes back to what acp-dsh has, and nothing polls for it', async () => {
  const off = agent('acp-claude', { on: false, connector: { state: 'off' } })
  const asked = []
  const request = async (endpoint) => {
    asked.push(endpoint)
    if (endpoint === 'acp-switch') throw new Error("The ACP agents' settings changed while saving. Try again.")
    return view([off])
  }
  const run = runHook(() => ui.useAcp(request))
  try {
    await run.settle()
    const [row] = run.current.view.agents
    assert.equal(run.current.isOn(row), false)
    const flipped = run.current.flip(row)
    await run.settle()
    await flipped
    await run.settle()
    assert.deepEqual(asked, ['acp', 'acp-switch'])
    assert.equal(run.current.isOn(row), false)
    assert.equal(run.current.busy, null)
    assert.match(run.current.problems['acp-claude'], /changed while saving/)
    assert.equal(run.intervals.size, 0)
  } finally {
    run.done()
  }
})

test('an accepted switch that has not settled yet keeps polling until acp-dsh says so', async () => {
  let on = false
  const row = () => agent('acp-claude', { on, connector: { state: on ? 'ready' : 'off' } })
  const request = async (endpoint) => (endpoint === 'acp-switch' ? view([agent('acp-claude', { on: false, connector: { state: 'off' } })]) : view([row()]))
  const run = runHook(() => ui.useAcp(request))
  try {
    await run.settle()
    await run.current.flip(run.current.view.agents[0])
    await run.settle()
    assert.equal(run.current.isOn(run.current.view.agents[0]), true)
    assert.equal(run.intervals.size, 1)
    on = true
    await run.current.check(run.current.view.agents[0])
    await run.settle()
    assert.equal(run.current.view.agents[0].on, true)
    assert.equal(run.intervals.size, 0)
  } finally {
    run.done()
  }
})

test('without acp-dsh the agents\' list draws nothing', () => {
  assert.equal(ui.AcpAgents({ acp: { view: { available: false, agents: [] } } }), null)
  assert.equal(ui.AcpAgents({ acp: { view: null } }), null)
  const section = render(ui.AcpAgents({ acp: acpOf([agent('acp-claude'), agent('acp-codex')]) }))
  assert.equal(findAll(section, node => node.props?.['data-acp']).length, 2)
  // No heading of its own: Settings' page has one, and Connect AI draws no list of them.
  assert.doesNotMatch(textOf(section), /Coding agents/)
})

test('the Settings section is always there, and says so when acp-dsh is not running', async () => {
  const registered = []
  const ctx = { slots: { inject: (name, register) => { register(); return () => registered.push('disposed') }, register: (options, component) => registered.push([options.id, component]) } }
  const dispose = ui.installAcpSection(ctx)
  assert.deepEqual(registered, [['acp-agents', ui.AcpSettingsSection], ['acp-agents', ui.AcpSectionIcon]])
  dispose()
  assert.deepEqual(registered.slice(2), ['disposed', 'disposed'])
  // Without acp-dsh the host's route does not answer (here: no fetch at all), and the page says so.
  const run = runHook(() => ui.AcpSettingsSection())
  try {
    assert.match(textOf(render(run.current)), /Looking at what this computer has/)
    await run.settle()
    assert.match(textOf(render(run.current)), /The ACP agents plugin is not running in this DSH/)
  } finally {
    run.done()
  }
})

test('the rows read in pt-BR once it is the DSH language', () => {
  const fill = (text, params) => text.replace(/\{(\w+)\}/g, (match, name) => (params && name in params ? String(params[name]) : match))
  const off = ui.installLocale({ register: () => () => {}, bind: () => (key, params) => fill(ui.PT_BR[key] ?? key, params) })
  try {
    const text = textOf(rowOf(agent('acp-codex', { connector: { state: 'failed', error: 'npm answered 503' }, signedIn: false })))
    assert.match(text, /A CLI codex está neste computador/)
    assert.match(text, /Sem login no Codex\. Entre pelo chat de um Bot\./)
    assert.match(text, /Ou rode codex login em um terminal e verifique de novo\./)
    assert.match(text, /Entrar/)
    assert.match(text, /O conector não foi instalado: npm answered 503/)
    assert.match(text, /Tentar de novo/)
  } finally {
    off()
  }
})

// --- The native-ACP agents (acp-dsh #959): Hermes, Antigravity, omp ----------------------------

const NATIVE = {
  'acp-hermes': { key: 'hermes', name: 'Hermes', cli: 'hermes', hint: 'hermes acp --setup' },
  'acp-antigravity': { key: 'antigravity', name: 'Antigravity', cli: 'agy', hint: 'agy acp --login' },
  'acp-omp': { key: 'omp', name: 'omp', cli: 'omp', hint: 'omp login' },
}
const nativeAgent = (id, over = {}) => agent(id, {
  key: NATIVE[id].key,
  name: NATIVE[id].name,
  cli: { found: true, installUrl: 'https://example.com/install', signInHint: NATIVE[id].hint, state: 'ready' },
  connector: { state: 'ready', native: true },
  ...over,
})

test('the native agents pass through with their terminal sign-in command, and their switch is their own key', async () => {
  const acp = fakeAcp([agent('acp-claude'), ...Object.keys(NATIVE).map(id => nativeAgent(id, { on: false, connector: { state: 'off', native: true }, signedIn: undefined }))])
  const fake = host({ acp, entries: { 'omni-ai': {}, [ACP_ENTRY]: {} } })
  const { value } = await fake.handle('acp', null)
  assert.deepEqual(value.agents.map(row => row.id), ['acp-claude', 'acp-hermes', 'acp-antigravity', 'acp-omp'])
  const hermes = value.agents.find(row => row.id === 'acp-hermes')
  assert.deepEqual(hermes.connector, { state: 'off', native: true })
  assert.equal(hermes.cli.signInHint, 'hermes acp --setup')
  assert.equal(value.agents.find(row => row.id === 'acp-claude').connector.native, undefined)
  for (const id of Object.keys(NATIVE)) assert.equal((await fake.handle('acp-switch', { id, on: true })).ok, true)
  assert.deepEqual(fake.updates.map(update => update.patch), [{ hermes: true }, { antigravity: true }, { omp: true }])
  // Only a plain command line is shown as the sign-in command.
  for (const bad of ['hermes acp --setup; rm -rf x', 'Run `x`', '$(x)', 'a'.repeat(200), 7]) {
    assert.equal(agentView(nativeAgent('acp-hermes', { cli: { found: true, signInHint: bad } })).cli.signInHint, undefined)
  }
})

test('a native agent that is not installed is shown with its install page, not hidden', () => {
  const acp = acpOf([])
  const tree = rowOf(nativeAgent('acp-antigravity', { cli: { found: false, installUrl: 'https://antigravity.google/docs', signInHint: 'agy acp --login', state: 'missing' }, connector: { state: 'no-cli', native: true }, signedIn: undefined }), acp)
  assert.equal(tree.props['data-state'], 'no-cli')
  assert.match(textOf(tree), /Not installed/)
  assert.match(textOf(tree), /The agy CLI is not on this computer/)
  const [link] = findAll(tree, node => node.type === 'a')
  assert.equal(link.props.href, 'https://antigravity.google/docs')
  assert.equal(textOf(link), 'Install Antigravity')
  assert.doesNotMatch(textOf(tree), /Installing/)
})

test('a native agent that is off says what turning it on means, and asks for no sign-in check', () => {
  const tree = rowOf(nativeAgent('acp-hermes', { on: false, connector: { state: 'off', native: true }, signedIn: undefined }))
  assert.equal(tree.props['data-state'], 'off')
  assert.match(textOf(tree), /Off\. Turn it on to use Hermes as a model in DSH\./)
  assert.match(textOf(tree), /Turning it on lets Automagik use the sign-in Hermes already has on this computer\./)
  assert.doesNotMatch(textOf(tree), /has not been checked yet/)
  assert.deepEqual(buttons(tree, 'Check again'), [])
  // Claude Code keeps its own off row: no such line.
  assert.doesNotMatch(textOf(rowOf(agent('acp-claude', { on: false, connector: { state: 'off' } }))), /Turning it on lets Automagik/)
})

test('a signed-out native agent names its terminal command, with no sign-in in a Bot\'s chat', () => {
  const acp = acpOf([])
  const tree = rowOf(nativeAgent('acp-omp', { signedIn: false }), acp)
  assert.equal(tree.props['data-state'], 'login-required')
  assert.match(textOf(tree), /Not signed in to omp\. Run omp login in a terminal, then check again\./)
  assert.deepEqual(buttons(tree, 'Sign in'), [])
  assert.doesNotMatch(textOf(tree), /Bot's chat/)
  buttons(tree, 'Check again')[0].props.onClick()
  assert.deepEqual(acp.acted, [['check', 'acp-omp']])
  // The chat's sign-in bridge is never opened for one.
  let opened = 0
  assert.equal(ui.openChatLogin('acp-omp', { [ui.CHAT_LOGIN]: { open: () => { opened++; return true } } }), false)
  assert.equal(opened, 0)
})

test('a ready native agent shows no connector line: its CLI is the ACP server', () => {
  const tree = rowOf(nativeAgent('acp-hermes'))
  assert.equal(tree.props['data-state'], 'ready')
  assert.match(textOf(tree), /Signed in to Hermes\./)
  assert.match(textOf(tree), /Ready: pick Hermes in the model picker\./)
  assert.doesNotMatch(textOf(tree), /Connector/)
  assert.match(textOf(tree), /Your own hermes CLI, as a model in DSH/)
})

const accountEntry = (account = { kind: 'account', email: 'a@example.test' }) => ({
  authScope: 'isolated', signedIn: true, account,
})

function accountSettings({
  entries = { 'acp-codex': accountEntry() },
  agents = [agent('acp-codex', { authScope: 'isolated' })],
  foundFace = true,
  missingAction,
  snapshot = { mainBotIds: ['missing', 'main'], mainBotId: 'fallback', byId: { main: {}, fallback: {} } },
  opens = true,
  refusal,
  hostText,
} = {}) {
  const calls = []
  const face = {
    hooks: { roster: { getSnapshot: () => snapshot } },
    actions: {
      cliLoginAccounts: async () => { calls.push(['accounts']); return { accounts: entries } },
      cliLoginSwitch: async (...args) => { calls.push(['switch', ...args]); if (refusal) throw new Error(refusal) },
      refreshModels: async () => { calls.push(['refresh']) },
    },
    hostText,
  }
  if (missingAction) delete face.actions[missingAction]
  const load = () => ({ omni: { face: () => foundFace ? face : null } })
  const close = () => calls.push(['close'])
  sandbox.fetch = async () => ({ ok: true, json: async () => ({ ok: true, value: view(agents) }) })
  sandbox[ui.CHAT_LOGIN] = { open: id => { calls.push(['open', id]); return opens } }
  const run = runHook(() => ui.AcpSettingsSection({ close, load }))
  return {
    calls,
    tree: () => render(run.current),
    settle: run.settle,
    done() {
      run.done()
      delete sandbox.fetch
      delete sandbox[ui.CHAT_LOGIN]
    },
  }
}

test('Coding agents is the menu label, heading and accessible list name in English and pt-BR', async () => {
  for (const [pt, name] of [[false, 'Coding agents'], [true, 'Agentes de código']]) {
    const off = pt ? ui.installLocale({ register() {}, bind: () => key => ui.PT_BR[key] ?? key }) : () => {}
    const section = accountSettings()
    const entries = []
    const dispose = ui.installAcpSection({ slots: {
      inject: (slot, register) => { register(); return () => {} },
      register: options => entries.push(options),
    } })
    try {
      await section.settle()
      const tree = section.tree()
      const [heading] = findAll(tree, node => node.type === 'h1')
      const [list] = findAll(tree, node => node.type === 'section')
      assert.equal(entries[0].id, 'acp-agents')
      assert.equal(entries[0].label(), name)
      assert.equal(textOf(heading), name)
      assert.equal(list.props['aria-label'], name)
      if (pt) assert.equal(buttons(tree, 'Trocar de conta').length, 1)
    } finally {
      dispose()
      section.done()
      off()
    }
  }
})

test('Settings without the Bot face keeps the existing signed-in line', async () => {
  const section = accountSettings({ foundFace: false })
  try {
    await section.settle()
    assert.match(textOf(section.tree()), /Signed in to Codex\./)
    assert.doesNotMatch(textOf(section.tree()), /a@example\.test|share this account/)
    assert.equal(buttons(section.tree(), 'Switch account').length, 0)
    assert.deepEqual(section.calls, [])
  } finally { section.done() }
})

test('Settings without either account action keeps the existing signed-in line', async () => {
  for (const missingAction of ['cliLoginAccounts', 'cliLoginSwitch']) {
    const section = accountSettings({ missingAction })
    try {
      await section.settle()
      assert.match(textOf(section.tree()), /Signed in to Codex\./)
      assert.doesNotMatch(textOf(section.tree()), /a@example\.test|share this account/)
      assert.equal(buttons(section.tree(), 'Switch account').length, 0)
      assert.deepEqual(section.calls, [])
    } finally { section.done() }
  }
})

test('two Settings rows share one account read and only account sign-ins show a label', async () => {
  const entries = {
    'acp-codex': accountEntry(),
    'acp-claude': accountEntry({ kind: 'key', email: 'b@example.test' }),
  }
  const agents = ['acp-codex', 'acp-claude'].map(id => agent(id, { authScope: 'isolated' }))
  const section = accountSettings({ entries, agents })
  try {
    await section.settle()
    const tree = section.tree()
    const text = textOf(tree)
    assert.match(text, /Signed in to Codex as a@example\.test\./)
    assert.match(text, /Signed in to Claude Code\./)
    assert.doesNotMatch(text, /b@example\.test/)
    assert.match(text, /Bots in this installation share this account\. Your terminal sign-in stays as it is\./)
    assert.equal(buttons(tree, 'Switch account').length, 2)
    assert.deepEqual(section.calls, [['accounts']])
  } finally { section.done() }

  const reopened = accountSettings({ entries: { 'acp-codex': accountEntry({ kind: 'account', org: 'Example Org' }) } })
  try {
    await reopened.settle()
    assert.match(textOf(reopened.tree()), /Signed in to Codex as Example Org\./)
    assert.deepEqual(reopened.calls, [['accounts']])
  } finally { reopened.done() }
})

test('account details and switch require an isolated, consented, signed-in non-native row and entry', () => {
  const entry = accountEntry()
  const row = agent('acp-codex', { authScope: 'isolated' })
  for (const [candidate, account] of [
    [row, { ...entry, authScope: 'shared' }],
    [row, { ...entry, signedIn: false }],
    [{ ...row, authScope: 'shared' }, entry],
    [{ ...row, signedIn: false }, entry],
    [{ ...row, consent: 'needed' }, entry],
    [nativeAgent('acp-hermes', { authScope: 'isolated' }), entry],
  ]) {
    const lines = ui.agentLines(candidate, account)
    assert.equal(lines.some(line => line.action === 'switch'), false)
    assert.equal(lines.some(line => line.text.includes('a@example.test')), false)
    assert.equal(lines.some(line => line.text.includes('share this account')), false)
  }
})

test('the octopus ghost opacity rule applies to paths without hiding Coding agents buttons', () => {
  assert.doesNotMatch(STAGE_CSS, /(?:^|[},])\s*\.oai-ghost\s*\{\s*opacity\s*:\s*0\s*;?\s*\}/)
  assert.ok(STAGE_CSS.includes('path.oai-ghost{opacity:0}'))
})

test('Switch account confirms once on the Main Bot, refreshes, opens the chat and closes Settings', async () => {
  const section = accountSettings()
  try {
    await section.settle()
    const [switchAccount] = buttons(section.tree(), 'Switch account')
    assert.equal(switchAccount.props.className, 'oai-ghost oai-acp-act')
    switchAccount.props.onClick()
    await section.settle()
    assert.match(textOf(section.tree()), /This stops running Bot work for this account\. Continue\?/)
    assert.doesNotMatch(textOf(section.tree()), /Signed in to Codex as/)
    buttons(section.tree(), 'Cancel')[0].props.onClick()
    await section.settle()
    assert.deepEqual(section.calls, [['accounts']])
    buttons(section.tree(), 'Switch account')[0].props.onClick()
    await section.settle()
    const confirm = buttons(section.tree(), 'Continue')[0].props.onClick
    confirm()
    confirm()
    await section.settle()
    assert.deepEqual(section.calls, [['accounts'], ['switch', 'main', 'acp-codex'], ['refresh'], ['open', 'acp-codex'], ['close']])
  } finally { section.done() }
})

test('a failed switch or a missing chat says why and keeps Settings open', async () => {
  const noChat = 'Sign-in needs a Bot chat. If you have no Bot yet, set one up first.'
  const refusal = 'The Bot account cannot be changed from this session. Use the app on this computer.'
  for (const [options, expected, calls] of [
    [{ opens: false, snapshot: { mainBotIds: ['missing'], mainBotId: 'main', byId: { main: {} } } }, noChat, [['switch', 'main', 'acp-codex'], ['refresh'], ['open', 'acp-codex']]],
    [{ snapshot: { mainBotIds: ['missing'], byId: {} } }, noChat, []],
    [{ refusal }, refusal, [['switch', 'main', 'acp-codex']]],
    [{ refusal, hostText: () => 'Conta indisponível.' }, 'Conta indisponível.', [['switch', 'main', 'acp-codex']]],
  ]) {
    const section = accountSettings(options)
    try {
      await section.settle()
      buttons(section.tree(), 'Switch account')[0].props.onClick()
      await section.settle()
      buttons(section.tree(), 'Continue')[0].props.onClick()
      await section.settle()
      const [problem] = findAll(section.tree(), node => node.props?.role === 'alert')
      assert.equal(textOf(problem), expected)
      assert.deepEqual(section.calls, [['accounts'], ...calls])
    } finally { section.done() }
  }
})

// #2064: a Switch account hands its own attempt to the chat's row; a plain Sign in hands none.
test('the default bridge gets the switch\'s attempt, and a plain Sign in passes nothing (B14)', async () => {
  const calls = []
  const row = agentView(agent('acp-codex', { signedIn: false, authScope: 'isolated' }))
  const attemptId = 'attempt_000000000000000000000002'
  // The options object comes from the page's realm: copied here, so it compares by value.
  sandbox[ui.CHAT_LOGIN] = { open: (provider, options) => { calls.push([provider, options === undefined ? undefined : { ...options }]); return true } }
  const request = async () => ({ available: true, agents: [row] })
  const run = runHook(() => ui.useAcp(request))
  try {
    await run.settle()
    assert.equal(run.current.login(row, { attemptId }), true)
    assert.deepEqual(calls, [['acp-codex', { attemptId }]])
    calls.length = 0
    assert.equal(run.current.login(row), true)
    assert.deepEqual(calls, [['acp-codex', undefined]])
    await run.settle()
    assert.equal(run.current.problems['acp-codex'] ?? null, null, 'no "Sign-in needs a Bot chat." message')
  } finally {
    run.done()
    delete sandbox[ui.CHAT_LOGIN]
  }
})

test('Settings\' Switch account opens the chat\'s row on the switch\'s own attempt (B14)', async () => {
  const attemptId = 'attempt_000000000000000000000002'
  for (const [answer, options] of [[{ id: 'acp-codex', attemptId, status: 'failed', signedIn: false }, { attemptId }],
    [{ id: 'acp-codex', signedIn: false }, undefined], [undefined, undefined]]) {
    const calls = []
    const face = {
      hooks: { roster: { getSnapshot: () => ({ mainBotIds: ['main'], byId: { main: {} } }) } },
      actions: {
        cliLoginAccounts: async () => ({ accounts: { 'acp-codex': accountEntry() } }),
        cliLoginSwitch: async (...args) => { calls.push(['switch', ...args]); return answer },
        refreshModels: async () => {},
      },
    }
    sandbox.fetch = async () => ({ ok: true, json: async () => ({ ok: true, value: view([agent('acp-codex', { authScope: 'isolated' })]) }) })
    sandbox[ui.CHAT_LOGIN] = { open: (provider, opened) => { calls.push(['open', provider, opened === undefined ? undefined : { ...opened }]); return true } }
    const run = runHook(() => ui.AcpSettingsSection({ close: () => calls.push(['close']), load: () => ({ omni: { face: () => face } }) }))
    try {
      await run.settle()
      buttons(render(run.current), 'Switch account')[0].props.onClick()
      await run.settle()
      buttons(render(run.current), 'Continue')[0].props.onClick()
      await run.settle()
      assert.deepEqual(calls, [['switch', 'main', 'acp-codex'], ['open', 'acp-codex', options], ['close']])
    } finally {
      run.done()
      delete sandbox.fetch
      delete sandbox[ui.CHAT_LOGIN]
    }
  }
})
