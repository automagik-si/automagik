// A connector that is installed but did not start (#970, acp-dsh's `connector.startError`): the
// row says so and offers Retry, which reinstalls it; never "Ready". acp-dsh is a fake.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { agentView } from '../src/host/acp.js'
import { PT_BR } from '../src/client/i18n.js'

// A credential-shaped string, built at run time so no key-shaped literal sits in the source.
const FAKE_KEY = ['sk', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-')
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const agent = (id, over = {}) => ({
  id,
  key: id === 'acp-claude' ? 'claude' : 'codex',
  name: id === 'acp-claude' ? 'Claude Code' : 'Codex',
  on: true,
  cli: { found: true, state: 'ready', installUrl: 'https://example.com/install' },
  connector: { state: 'ready', version: '1.2.3' },
  signedIn: true,
  model: { provider: id, id: 'default', name: 'x', listed: true },
  restartNeeded: false,
  ...over,
})

const bundle = await build({
  stdin: { contents: "export * from './src/client/acp-agents.js'", resolveDir: PLUGIN },
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

test('the host passes a start failure on, redacted and only for an installed connector', () => {
  const failed = agentView(agent('acp-codex', { connector: { state: 'ready', version: '2.6.0', startError: `Codex exited (1): token ${FAKE_KEY}` } }))
  assert.match(failed.connector.startError, /^Codex exited \(1\)/)
  assert.doesNotMatch(failed.connector.startError, new RegExp(FAKE_KEY))
  assert.equal('startError' in agentView(agent('acp-codex', { connector: { state: 'installing', startError: 'x' } })).connector, false)
  assert.equal('startError' in agentView(agent('acp-codex', { connector: { state: 'ready', startError: 42 } })).connector, false)
})

test('a connector that did not start reads so and offers Retry, never "Ready"', () => {
  const acted = []
  const row = agentView(agent('acp-codex', { connector: { state: 'ready', version: '2.6.0', startError: 'Codex exited (1)' } }))
  const acp = { view: { available: true, agents: [row] }, busy: null, problems: {}, isOn: item => item.on, flip() {}, retry: item => acted.push(['retry', item.id]), check() {}, login() {} }
  assert.equal(ui.stateOf(row), 'failed')
  assert.equal(ui.badgeOf(row), 'Needs a retry')
  const tree = render(ui.AcpAgentRow({ agent: row, acp }))
  const text = textOf(tree)
  assert.match(text, /The connector did not start: Codex exited \(1\)/)
  assert.doesNotMatch(text, /Ready: pick/)
  assert.doesNotMatch(text, /Connector ready/)
  const [button] = findAll(tree, node => node.type === 'button' && textOf(node) === 'Retry')
  button.props.onClick()
  assert.deepEqual(acted, [['retry', 'acp-codex']])
  // Without a start failure it draws as before.
  const ready = agentView(agent('acp-codex'))
  assert.equal(ui.stateOf(ready), 'ready')
  assert.match(textOf(render(ui.AcpAgentRow({ agent: ready, acp }))), /Connector ready \(version 1\.2\.3\)/)
  assert.ok(Object.hasOwn(PT_BR, 'The connector did not start: {error}'))
})
