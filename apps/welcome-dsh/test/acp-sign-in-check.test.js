// When a CLI's sign-in check could not tell, Settings says why and offers to check again.
// Only the two reasons acp-dsh names can reach either page response.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { agentView } from '../src/host/acp.js'
import { install } from '../src/host/endpoint.js'
import { fakeContext } from './fake-ctx.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const EMAIL = 'someone@example.com'
const OBJECT_MARKER = 'private check detail'
const OBJECT = { detail: OBJECT_MARKER }
const agent = (over = {}) => ({
  id: 'acp-claude', key: 'claude', name: 'Claude Code', on: true,
  cli: { found: true, state: 'ready' }, connector: { state: 'ready' },
  ...over,
})
const codex = over => agent({ id: 'acp-codex', key: 'codex', name: 'Codex', ...over })

function host(agents) {
  const acpAgents = { status: async () => ({ agents }) }
  const fake = fakeContext({ entries: { 'omni-ai': {} }, services: { acpAgents } })
  return install(fake.ctx, { fetch: async () => { throw new Error('offline') } })
}

test('the host gives only the two reasons, and only for an unknown sign-in', () => {
  for (const signInCheck of ['timeout', 'unreadable']) {
    assert.equal(agentView(agent({ signInCheck })).signInCheck, signInCheck)
    for (const signedIn of [true, false, null]) {
      assert.equal('signInCheck' in agentView(agent({ signInCheck, signedIn })), false)
    }
  }
  for (const signInCheck of ['other', '', EMAIL, OBJECT]) {
    const view = agentView(agent({ signInCheck }))
    assert.equal('signInCheck' in view, false)
    const serialized = JSON.stringify(view)
    assert.ok(!serialized.includes(EMAIL))
    assert.ok(!serialized.includes(OBJECT_MARKER))
  }
})

test('acp and ais carry the reasons through to the page', async () => {
  const { handle } = host([agent({ signInCheck: 'timeout' }), codex({ signInCheck: 'unreadable' })])
  const acp = await handle('acp')
  assert.equal(acp.ok, true)
  assert.deepEqual(acp.value.agents.map(row => [row.id, row.signInCheck]), [['acp-claude', 'timeout'], ['acp-codex', 'unreadable']])

  const ais = JSON.parse(JSON.stringify(await handle('ais')))
  assert.equal(ais.ok, true)
  assert.equal(ais.value.rows.find(row => row.id === 'claude').cli.signInCheck, 'timeout')
  assert.equal(ais.value.rows.find(row => row.id === 'chatgpt').cli.signInCheck, 'unreadable')
})

test('ais sends neither an email-like reason nor an object', async () => {
  const { handle } = host([agent({ signInCheck: EMAIL }), codex({ signInCheck: OBJECT })])
  const serialized = JSON.stringify(await handle('ais'))
  assert.ok(!serialized.includes(EMAIL))
  assert.ok(!serialized.includes(OBJECT_MARKER))
  const ais = JSON.parse(serialized)
  assert.equal(ais.ok, true)
  assert.equal('signInCheck' in ais.value.rows.find(row => row.id === 'claude').cli, false)
  assert.equal('signInCheck' in ais.value.rows.find(row => row.id === 'chatgpt').cli, false)
})

const bundle = await build({
  stdin: { contents: "export * from './src/client/acp-agents.js'\nexport { installLocale, PT_BR } from './src/client/i18n.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
})
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
runInNewContext(bundle.outputFiles[0].text, { module: client, exports: client.exports, setInterval, clearInterval, require: name => ({ react, 'react-dom': {} })[name] })
const ui = client.exports

// As in acp.test.js, keep state by call order and run effects after each render.
function runHook(hook) {
  const slots = []
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
  draw()
  return {
    get current() { return result },
    settle: () => new Promise(done => setImmediate(done)),
    done() { for (const slot of slots) slot?.cleanup?.() },
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
const buttons = (tree, label) => findAll(tree, node => node.type === 'button' && textOf(node) === label)
const rowOf = (agent, acp = { busy: null, problems: {}, isOn: row => row.on }) => render(ui.AcpAgentRow({ agent, acp }))
const NOT_CHECKED = 'The sign-in to Claude Code has not been checked yet.'
const TIMEOUT = 'Could not check the sign-in to Claude Code: claude took too long to answer.'
const UNREADABLE = 'Could not tell whether you are signed in to Claude Code.'

function assertUnknown(tree, sentence) {
  assert.equal(tree.props['data-state'], 'sign-in-unknown')
  assert.match(textOf(tree), /Check sign-in/)
  assert.ok(textOf(tree).includes(sentence))
  assert.equal(buttons(tree, 'Check again').length, 1)
  assert.deepEqual(buttons(tree, 'Sign in'), [])
}

function assertSignedOut(tree) {
  const text = textOf(tree)
  assert.equal(tree.props['data-state'], 'login-required')
  assert.match(text, /Not signed in to Claude Code\. Sign in from a Bot's chat\./)
  assert.match(text, /Or run claude auth login in a terminal, then check again\./)
  assert.ok(!text.includes(TIMEOUT))
  assert.ok(!text.includes(UNREADABLE))
  assert.equal(buttons(tree, 'Sign in').length, 1)
}

test('an unknown sign-in says why the check could not tell, until it has an answer', () => {
  for (const [signInCheck, sentence] of [['timeout', TIMEOUT], ['unreadable', UNREADABLE]]) {
    const tree = rowOf(agentView(agent({ signInCheck })))
    assertUnknown(tree, sentence)
    assert.doesNotMatch(textOf(tree), /has not been checked yet/)
  }
  assertSignedOut(rowOf(agentView(agent({ signedIn: false }))))
})

test('a native agent that is off draws no sign-in check line', () => {
  const row = agentView(agent({
    id: 'acp-hermes', key: 'hermes', name: 'Hermes', on: false,
    connector: { state: 'off', native: true }, signInCheck: 'timeout',
  }))
  assert.equal(row.signInCheck, 'timeout')
  const tree = rowOf(row)
  assert.equal(tree.props['data-state'], 'off')
  assert.doesNotMatch(textOf(tree), /Could not check|Could not tell|has not been checked yet/)
  assert.deepEqual(buttons(tree, 'Check again'), [])
  assert.deepEqual(buttons(tree, 'Sign in'), [])
})

test('the check reasons read in pt-BR once it is the DSH language', () => {
  const fill = (text, params) => text.replace(/\{(\w+)\}/g, (match, name) => (params && name in params ? String(params[name]) : match))
  const off = ui.installLocale({ register: () => () => {}, bind: () => (key, params) => fill(ui.PT_BR[key] ?? key, params) })
  try {
    const timeout = rowOf(agentView(agent({ signInCheck: 'timeout' })))
    assert.match(textOf(timeout), /Não foi possível verificar o login no Claude Code: o claude demorou demais para responder\./)
    const unreadable = rowOf(agentView(codex({ signInCheck: 'unreadable' })))
    assert.match(textOf(unreadable), /Não foi possível saber se há login no Codex\./)
  } finally {
    off()
  }
})

test('Check again refreshes the row through both reasons and back to Sign in', async () => {
  const rows = [agent(), agent({ signInCheck: 'unreadable' }), agent({ signInCheck: 'timeout' }), agent({ signedIn: false })]
  const calls = []
  const request = async (endpoint, payload) => {
    const row = rows[calls.length]
    calls.push([endpoint, structuredClone(payload)])
    return { available: true, agents: [agentView(row)] }
  }
  const run = runHook(() => ui.useAcp(request))
  const drawRow = () => rowOf(run.current.view.agents[0], run.current)
  const assertRefresh = count => assert.deepEqual(calls, Array.from({ length: count }, () => ['acp', { refresh: true }]))
  try {
    await run.settle()
    let tree = drawRow()
    assertRefresh(1)
    assertUnknown(tree, NOT_CHECKED)
    for (const [i, sentence] of [UNREADABLE, TIMEOUT].entries()) {
      await buttons(tree, 'Check again')[0].props.onClick()
      await run.settle()
      tree = drawRow()
      assertRefresh(i + 2)
      assertUnknown(tree, sentence)
      assert.doesNotMatch(textOf(tree), /has not been checked yet/)
    }
    await buttons(tree, 'Check again')[0].props.onClick()
    await run.settle()
    assertRefresh(4)
    assertSignedOut(drawRow())
  } finally {
    run.done()
  }
})
