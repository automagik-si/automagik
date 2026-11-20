// Connect AI's Sign in for Claude and ChatGPT (one sign-in per vendor: their CLIs, Claude Code and
// Codex): it opens the sign-in row in a Bot's chat through the Bot team's bridge, the step steps
// aside and stays open (no complete(), no `done`), and nothing about a sign-in is asked of the
// host (no DSH sign-in either). Back to setup brings the step back and looks at the agents and
// the rows again. The agents have no section of their own here (Settings has it).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { agentView } from '../src/host/acp.js'
import { VENDORS } from '../src/host/ais.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const BRIDGE = Symbol.for('automagik.cli-login')

const bundle = await build({
  stdin: { contents: "export * from './src/client/connect-ai.js'\nexport { StepAside, Stage } from './src/client/stage.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
})

// Hooks that keep state by call order for the one component run as a hook; anything drawn below
// it is drawn statelessly (the step's own children hold no state this test reads).
const stateless = {
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {}, useRef: current => ({ current }), useCallback: fn => fn, useMemo: fn => fn(),
}
let hooks = stateless
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => hooks.useState(initial),
  useEffect: (effect, deps) => hooks.useEffect(effect, deps),
  useRef: current => hooks.useRef(current),
  useCallback: (fn, deps) => hooks.useCallback(fn, deps),
  useMemo: (fn, deps) => hooks.useMemo(fn, deps),
}
const requests = []
let acpRows = []
// The host's Claude and ChatGPT rows over the agents (src/host/ais.js): set up only signed in.
const cliRow = (id, agent) => ({ ...VENDORS.find(vendor => vendor.id === id), ready: agent?.signedIn === true, on: false, found: null, signIn: agent !== undefined, ...(agent ? { cli: agentView(agent) } : {}) })
const aisRows = () => [cliRow('claude', acpRows.find(agent => agent.id === 'acp-claude')), cliRow('chatgpt', acpRows.find(agent => agent.id === 'acp-codex'))]
const answer = (endpoint) => {
  if (endpoint === 'state') return {}
  if (endpoint === 'ais') return { rows: aisRows(), subscriptions: null }
  if (endpoint === 'acp') return { available: true, agents: acpRows.map(agentView) }
  return {}
}
const sandbox = {
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  document: { body: {}, getElementById: () => null },
  fetch: async (route, init) => {
    const { endpoint, payload } = JSON.parse(init.body)
    requests.push([endpoint, payload])
    return { ok: true, json: async () => ({ ok: true, value: answer(endpoint) }) }
  },
}
const client = { exports: {} }
Object.assign(sandbox, { module: client, exports: client.exports, require: name => ({ react, 'react-dom': { createPortal: node => node } })[name] })
runInNewContext(bundle.outputFiles[0].text, sandbox)
const ui = client.exports

function runHook(hook) {
  const slots = []
  let index = 0
  let result
  let queued = false
  let effects = []
  const same = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
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
    useRef(current) { const i = index++; slots[i] ??= { current }; return slots[i] },
    useCallback(fn, deps) {
      const i = index++
      if (!(i in slots) || !same(slots[i].deps, deps)) slots[i] = { fn, deps }
      return slots[i].fn
    },
    useMemo(fn, deps) {
      const i = index++
      if (!(i in slots) || !same(slots[i].deps, deps)) slots[i] = { value: fn(), deps }
      return slots[i].value
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
    settle: async () => { for (let i = 0; i < 5; i++) await new Promise(done => setImmediate(done)) },
    done() { for (const slot of slots) slot?.cleanup?.() },
  }
}

// Draws an element tree; the Stage (a portal with effects) stands for its children.
function render(node) {
  if (Array.isArray(node)) return node.map(render)
  if (node === null || typeof node !== 'object') return node
  if (node.type === ui.Stage) return { type: 'stage', props: {}, children: render(node.children) }
  if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }))
  return { ...node, children: render(node.children) }
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
const startingWith = (tree, label) => findAll(tree, node => node.type === 'button' && textOf(node).startsWith(label))
const switchOf = (tree, name) => findAll(tree, node => node.props?.role === 'switch' && node.props['aria-label'] === name)[0]

const signedOutCodex = {
  id: 'acp-codex', key: 'codex', name: 'Codex', on: true,
  cli: { found: true, state: 'ready', version: '0.167.0' },
  connector: { state: 'ready', version: '1.0.0' },
  signedIn: false,
  model: { listed: true }, restartNeeded: false,
}

test('ChatGPT\'s Sign in opens Codex\'s sign-in in the Bot chat through the bridge, steps aside, and never completes the step', async () => {
  requests.length = 0
  acpRows = [signedOutCodex]
  const opened = []
  sandbox[BRIDGE] = { open: (provider) => { opened.push(provider); return true } }
  let completed = 0
  const props = { stepId: 'omni-connect-ai', complete: () => { completed++ }, openSection: () => {} }
  const run = runHook(() => ui.ConnectAiStep(props))
  try {
    await run.settle()
    let tree = render(run.current)
    // No Coding agents section, no agent rows of their own: Claude and ChatGPT are the CLIs.
    assert.doesNotMatch(textOf(tree), /Coding agents/)
    assert.equal(findAll(tree, node => node.props?.['data-acp']).length, 0)
    // Not signed in: the switch opens the setup, which offers Codex's sign-in only.
    switchOf(tree, 'ChatGPT').props.onClick()
    await run.settle()
    tree = render(run.current)
    assert.equal(startingWith(tree, 'Use an API key').length, 0)
    const before = requests.length

    startingWith(tree, 'Sign in to Codex')[0].props.onClick()
    await run.settle()
    assert.deepEqual(opened, ['acp-codex'])
    assert.equal(completed, 0)
    // Nothing about the sign-in went to the host: no done, no model, no switch, no DSH sign-in.
    assert.deepEqual(requests.slice(before), [])
    assert.equal(run.current.type, ui.StepAside)
    const aside = render(run.current)
    assert.match(textOf(aside), /Sign in from the Bot's chat, then come back to finish setting up\./)
    assert.equal(findAll(aside, node => node.type === 'input').length, 0)

    // Signed in meanwhile: back on the step, the agents and the rows are read again.
    acpRows = [{ ...signedOutCodex, signedIn: true }]
    buttons(aside, 'Back to setup')[0].props.onClick()
    await run.settle()
    assert.notEqual(run.current.type, ui.StepAside)
    assert.equal(completed, 0)
    const after = requests.slice(before)
    assert.deepEqual(after[0], ['acp', { refresh: true }])
    assert.ok(after.some(([endpoint]) => endpoint === 'ais'))
    assert.ok(!requests.some(([endpoint]) => endpoint === 'done' || endpoint.startsWith('signin-')))
    assert.equal(findAll(render(run.current), node => node.props?.role === 'switch' && node.props['aria-label'] === 'ChatGPT').length, 1)
  } finally {
    delete sandbox[BRIDGE]
    run.done()
  }
})

test('Claude\'s setup offers Claude Code\'s sign-in or an API key; without a Bot chat the step stays and says to use the terminal', async () => {
  requests.length = 0
  acpRows = [{ ...signedOutCodex, id: 'acp-claude', key: 'claude', name: 'Claude Code' }]
  sandbox[BRIDGE] = { open: () => false }
  let completed = 0
  const run = runHook(() => ui.ConnectAiStep({ stepId: 'omni-connect-ai', complete: () => { completed++ }, openSection: () => {} }))
  try {
    await run.settle()
    switchOf(render(run.current), 'Claude').props.onClick()
    await run.settle()
    const tree = render(run.current)
    assert.equal(startingWith(tree, 'Use an API key').length, 1)
    startingWith(tree, 'Sign in to Claude Code')[0].props.onClick()
    await run.settle()
    assert.notEqual(run.current.type, ui.StepAside)
    assert.equal(completed, 0)
    assert.match(textOf(render(run.current)), /No Bot chat to sign in from here\. Run claude auth login in a terminal instead\./)
    assert.ok(!requests.some(([endpoint]) => endpoint.startsWith('signin-')))
  } finally {
    delete sandbox[BRIDGE]
    run.done()
  }
})

test('a CLI that is not on this computer shows where it stands in the setup instead of a sign-in', async () => {
  requests.length = 0
  acpRows = [{ ...signedOutCodex, cli: { found: false, installUrl: 'https://example.com/codex' }, signedIn: undefined }]
  const run = runHook(() => ui.ConnectAiStep({ stepId: 'omni-connect-ai', complete: () => {}, openSection: () => {} }))
  try {
    await run.settle()
    switchOf(render(run.current), 'ChatGPT').props.onClick()
    await run.settle()
    const tree = render(run.current)
    assert.equal(startingWith(tree, 'Sign in to Codex').length, 0)
    assert.match(textOf(tree), /The codex CLI is not on this computer\./)
    assert.equal(buttons(tree, 'Check again').length, 1)
  } finally {
    run.done()
  }
})

test('Connect AI shows no account details or switch for an isolated CLI', async () => {
  acpRows = [{ ...signedOutCodex, authScope: 'isolated', signedIn: true }]
  let accountReads = 0
  const require = sandbox.require
  sandbox.require = name => name === '@automagik/bots-dsh/client' ? {
    omni: { face: () => ({ actions: {
      cliLoginAccounts: async () => {
        accountReads++
        return { accounts: { 'acp-codex': { authScope: 'isolated', signedIn: true, account: { kind: 'account', email: 'a@example.test' } } } }
      },
      cliLoginSwitch: async () => {},
    } }) },
  } : require(name)
  const run = runHook(() => ui.ConnectAiStep({ stepId: 'omni-connect-ai', complete: () => {}, openSection: () => {} }))
  try {
    await run.settle()
    const tree = render(run.current)
    assert.ok(switchOf(tree, 'ChatGPT'))
    assert.doesNotMatch(textOf(tree), /a@example\.test|share this account/)
    assert.equal(buttons(tree, 'Switch account').length, 0)
    assert.equal(accountReads, 0)
  } finally {
    run.done()
    sandbox.require = require
  }
})
