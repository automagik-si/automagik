// Antigravity's Install button (#2048): the host passes `install: 'manual'` and the managed
// agy's sign-in command, `acp-install` asks acp-dsh's `installCli`, and the row offers Install
// only while the agent is on, with the install page only after a failed install.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { install } from '../src/host/endpoint.js'
import { ACP_ENTRY, agentView } from '../src/host/acp.js'
import { needsViewer } from '../src/host/viewer-policy.js'
import { fakeContext } from './fake-ctx.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const UUID = '1a2b3c4d-1111-2222-3333-444455556666'
const POSIX_PATH = `/srv/a/.automagik/acp/clis/agy/1.5.15-${UUID}/bin/agy`
const WIN32_PATH = `C:\\Users\\a\\.automagik\\acp\\clis\\agy\\1.5.15-${UUID}\\bin\\agy.exe`
const POSIX_HINT = `'${POSIX_PATH}' acp --login`
const WIN32_HINT = `& "${WIN32_PATH}" acp --login`
const GETTING_STARTED = 'https://antigravity.google/docs/getting-started'

const agy = (over = {}, cli = {}) => ({
  id: 'acp-antigravity', key: 'antigravity', name: 'Antigravity', on: true,
  cli: { found: false, installUrl: GETTING_STARTED, signInHint: 'agy acp --login', state: 'missing', install: 'manual', managed: false, ...cli },
  connector: { state: 'no-cli', native: true },
  model: { provider: 'acp-antigravity', id: 'default', name: 'x', listed: false },
  restartNeeded: false,
  ...over,
})

function host(service) {
  const fake = fakeContext({ entries: { 'omni-ai': {}, [ACP_ENTRY]: {} }, services: service ? { acpAgents: service } : {} })
  const { handle } = install(fake.ctx)
  return { ...fake, handle }
}

test('T13: the host passes install: manual only when exactly that', () => {
  assert.equal(agentView(agy()).cli.install, 'manual')
  for (const value of ['auto', true, 'MANUAL', undefined]) assert.equal(agentView(agy({}, { install: value })).cli.install, undefined)
  // Whether the copy found is the app's own reaches the page for a manual install only.
  assert.equal(agentView(agy({}, { found: true, managed: true })).cli.managed, true)
  assert.equal(agentView(agy({}, { found: true, managed: false })).cli.managed, undefined)
  assert.equal(agentView(agy({}, { install: undefined, found: true, managed: true })).cli.managed, undefined)
})

test('T13b: the managed agy\'s quoted command passes, in its two shapes only; any other hint is dropped', () => {
  const hint = value => agentView(agy({}, { signInHint: value })).cli.signInHint
  assert.equal(hint(POSIX_HINT), POSIX_HINT)
  assert.equal(hint(WIN32_HINT), WIN32_HINT)
  assert.equal(hint('agy acp --login'), 'agy acp --login')
  const bad = [
    `'/srv/a/.automagik/acp/clis/other/1.5.15-${UUID}/bin/agy' acp --login`,
    `'/srv/a/../b/acp/clis/agy/1.5.15-${UUID}/bin/agy' acp --login`,
    `'/srv/a/x/..\\acp/clis/agy/1.5.15-${UUID}/bin/agy' acp --login`,
    `'${POSIX_PATH}.exe' acp --login`,
    `'/srv/a/.automagik/acp/clis/agy/1.5.15-${UUID}/bin/agy.exe' acp --login`,
    `'/srv/a/.automagik/acp/clis/agy/1.5.15-nope/bin/agy' acp --login`,
    `${POSIX_HINT} --extra`,
    `${POSIX_HINT}; rm -rf ~`,
    `'/srv/o'hara/.automagik/acp/clis/agy/1.5.15-${UUID}/bin/agy' acp --login`,
    `'/srv/a\`b/.automagik/acp/clis/agy/1.5.15-${UUID}/bin/agy' acp --login`,
    `"${POSIX_PATH}" acp --login`,
    `'/srv/a\n/.automagik/acp/clis/agy/1.5.15-${UUID}/bin/agy' acp --login`,
    `'/${'a/'.repeat(2100)}acp/clis/agy/1.5.15-${UUID}/bin/agy' acp --login`,
    `'relative/acp/clis/agy/1.5.15-${UUID}/bin/agy' acp --login`,
    `& "C:\\Users\\a\u201D;calc;\u201D\\acp\\clis\\agy\\1.5.15-${UUID}\\bin\\agy.exe" acp --login`,
    `& "C:\\Users\\a\\..\\b\\acp\\clis\\agy\\1.5.15-${UUID}\\bin\\agy.exe" acp --login`,
    `& "C:\\Users\\$x\\acp\\clis\\agy\\1.5.15-${UUID}\\bin\\agy.exe" acp --login`,
    `& "C:\\Users\\a"b\\acp\\clis\\agy\\1.5.15-${UUID}\\bin\\agy.exe" acp --login`,
    `& "${WIN32_PATH.replace('agy.exe', 'agy')}" acp --login`,
    `& "${WIN32_PATH}" acp --login extra`,
  ]
  for (const value of bad) assert.equal(hint(value), undefined, value)
  // A single quote is legal in a Windows path: only the POSIX shape refuses it.
  const quoted = `& "C:\\Users\\o'hara\\acp\\clis\\agy\\1.5.15-${UUID}\\bin\\agy.exe" acp --login`
  assert.equal(hint(quoted), quoted)
})

test('T14: acp-install asks installCli with the id, passes its refusal, and needs the owner viewer', async () => {
  const calls = []
  const rows = [agy({}, { state: 'installing' })]
  const service = {
    status: async () => ({ agents: rows }),
    installCli: async (id) => {
      calls.push(id)
      if (calls.length === 2) throw Object.assign(new Error('Turn Antigravity on first.'), { code: 'acp-install/off' })
      return { agents: rows }
    },
  }
  const fake = host(service)
  const reply = await fake.handle('acp-install', { id: 'acp-antigravity' })
  assert.equal(reply.ok, true)
  assert.equal(reply.value.agents[0].cli.state, 'installing')
  assert.deepEqual(calls, ['acp-antigravity'])
  const off = await fake.handle('acp-install', { id: 'acp-antigravity' })
  assert.equal(off.ok, false)
  assert.equal(off.error.code, 'omni-ai/refused')
  assert.equal(off.error.message, 'Turn Antigravity on first.')
  assert.equal((await fake.handle('acp-install', { id: 'acp-gemini' })).error.code, 'omni-ai/invalid')
  // An acp-dsh without installCli, and no acp-dsh at all, refuse in words.
  const older = await host({ status: async () => ({ agents: rows }) }).handle('acp-install', { id: 'acp-antigravity' })
  assert.equal(older.error.code, 'omni-ai/refused')
  assert.match(older.error.message, /cannot install that CLI/)
  assert.equal((await host().handle('acp-install', { id: 'acp-antigravity' })).error.code, 'omni-ai/refused')
  assert.equal(needsViewer('acp-install'), true)
})

// ---- The row --------------------------------------------------------------------------------

const bundle = await build({
  stdin: { contents: "export * from './src/client/acp-agents.js'\nexport { installLocale, PT_BR } from './src/client/i18n.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {}, useRef: current => ({ current }), useCallback: fn => fn,
}
const client = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, { module: client, exports: client.exports, setTimeout, clearTimeout, setInterval, clearInterval, require: name => ({ react, 'react-dom': {} })[name] })
const ui = client.exports

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
const acpOf = (over = {}) => {
  const acted = []
  return { acted, view: { available: true, agents: [] }, busy: null, problems: {}, isOn: row => row.on, flip: row => acted.push(['flip', row.id]), retry: row => acted.push(['retry', row.id]), install: row => acted.push(['install', row.id]), check: row => acted.push(['check', row.id]), login: row => acted.push(['login', row.id]), ...over }
}
const rowOf = (row, acp = acpOf()) => render(ui.AcpAgentRow({ agent: agentView(row), acp }))
const buttons = (tree, label) => findAll(tree, node => node.type === 'button' && textOf(node) === label)
const links = tree => findAll(tree, node => node.type === 'a')

test('T15: off and missing: no button, no link, the turn-on line', () => {
  const tree = rowOf(agy({ on: false, connector: { state: 'off', native: true } }))
  assert.match(textOf(tree), /The agy CLI is not on this computer\. Turn Antigravity on to install it\./)
  assert.doesNotMatch(textOf(tree), /\{/)
  assert.deepEqual(buttons(tree, 'Install'), [])
  assert.deepEqual(links(tree), [])
})

test('T15: on and missing: Install posts acp-install, with no link; the switch the person just flipped counts', () => {
  const acp = acpOf()
  const tree = rowOf(agy(), acp)
  assert.match(textOf(tree), /The agy CLI is not on this computer\. Automagik can install it for you\./)
  assert.deepEqual(links(tree), [])
  buttons(tree, 'Install')[0].props.onClick()
  assert.deepEqual(acp.acted, [['install', 'acp-antigravity']])
  // Off in acp-dsh, but just switched on in the page: Install shows at once.
  const flipped = rowOf(agy({ on: false, connector: { state: 'off', native: true } }), acpOf({ isOn: () => true }))
  assert.equal(buttons(flipped, 'Install').length, 1)
})

test('T15: installing, failed and found', () => {
  const busy = rowOf(agy({}, { state: 'installing' }))
  assert.match(textOf(busy), /Installing Antigravity…/)
  assert.doesNotMatch(textOf(busy), /automatically/)
  assert.deepEqual(buttons(busy, 'Install'), [])
  assert.deepEqual(links(busy), [])

  const acp = acpOf()
  const failed = rowOf(agy({}, { state: 'failed', error: 'Antigravity\'s download did not match its published checksum', diagnostic: 'x' }), acp)
  assert.match(textOf(failed), /The Antigravity installation or update failed: Antigravity's download did not match its published checksum/)
  buttons(failed, 'Retry')[0].props.onClick()
  assert.deepEqual(acp.acted, [['install', 'acp-antigravity']])
  const [link] = links(failed)
  assert.equal(link.props.href, GETTING_STARTED)
  assert.equal(textOf(link), 'Install it yourself instead')

  const found = rowOf(agy({ signedIn: false, connector: { state: 'ready', native: true } }, { found: true, state: 'ready', managed: true, version: '1.5.15', signInHint: POSIX_HINT }))
  const text = textOf(found)
  assert.match(text, /Found the agy CLI \(installed by Automagik as version 1\.5\.15; it updates itself\)\./)
  assert.ok(text.includes(`Run ${POSIX_HINT} in a terminal, then check again.`))
  assert.doesNotMatch(text, /\{/)
  assert.deepEqual(buttons(found, 'Install'), [])
})

test('T15: a row without install keeps today\'s lines, and the new lines read in pt-BR', () => {
  const hermes = rowOf({ ...agy({ id: 'acp-hermes', key: 'hermes', name: 'Hermes' }, { install: undefined, installUrl: 'https://example.com/hermes', signInHint: 'hermes acp --setup' }) })
  assert.match(textOf(hermes), /The hermes CLI is not on this computer\. Install it, sign in, then check again\./)
  assert.equal(links(hermes)[0].props.href, 'https://example.com/hermes')
  assert.deepEqual(buttons(hermes, 'Install'), [])
  const keys = ['Installing {name}…', 'Install it yourself instead', 'The {cli} CLI is not on this computer. Automagik can install it for you.', 'The {cli} CLI is not on this computer. Turn {name} on to install it.', 'Found the {cli} CLI (installed by Automagik as version {version}; it updates itself).']
  for (const key of keys) assert.equal(typeof ui.PT_BR[key], 'string', key)
  const fill = (text, params) => text.replace(/\{(\w+)\}/g, (match, name) => (params && name in params ? String(params[name]) : match))
  const off = ui.installLocale({ register: () => () => {}, bind: () => (key, params) => fill(ui.PT_BR[key] ?? key, params) })
  try {
    assert.match(textOf(rowOf(agy())), /O Automagik pode instalar para você\./)
    assert.match(textOf(rowOf(agy({}, { found: true, state: 'ready', managed: true, version: '1.5.15' }))), /instalada pelo Automagik na versão 1\.5\.15; ela se atualiza sozinha/)
  } finally {
    off()
  }
})
