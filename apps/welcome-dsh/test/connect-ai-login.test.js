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
// Antigravity's row (#2048) only when acp-dsh offers its sign-in in the app, as the host lists it.
const agyOf = () => acpRows.find(agent => agent.id === 'acp-antigravity' && agent.appSignIn === true)
const aisRows = () => [cliRow('claude', acpRows.find(agent => agent.id === 'acp-claude')), cliRow('chatgpt', acpRows.find(agent => agent.id === 'acp-codex')),
  ...(agyOf() ? [cliRow('antigravity', agyOf())] : [])]
// acp-dsh's answers to the agents' own endpoints: the switch moves the agent's `on`; a test may
// set `acpAnswer` to refuse or change what an endpoint does.
let acpAnswer = () => undefined
const answer = (endpoint, payload) => {
  if (endpoint === 'state') return {}
  if (endpoint === 'ais') return { rows: aisRows(), subscriptions: null }
  if (endpoint.startsWith('acp-')) {
    acpAnswer(endpoint, payload)
    if (endpoint === 'acp-switch') acpRows = acpRows.map(agent => (agent.id === payload.id ? { ...agent, on: payload.on } : agent))
  }
  if (endpoint === 'acp' || endpoint.startsWith('acp-')) return { available: true, agents: acpRows.map(agentView) }
  return {}
}
const sandbox = {
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  document: { body: {}, getElementById: () => null },
  fetch: async (route, init) => {
    const { endpoint, payload } = JSON.parse(init.body)
    requests.push([endpoint, payload])
    let value
    try { value = answer(endpoint, payload) } catch (error) {
      return { ok: true, json: async () => ({ ok: false, error: { code: 'omni-ai/refused', message: error.message } }) }
    }
    return { ok: true, json: async () => ({ ok: true, value }) }
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

// ---- Antigravity's row (#2048, r6): turned on, installed and signed in in place --------------

const AGY_LINK = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=1-a.apps.googleusercontent.com'
  + '&redirect_uri=http%3A%2F%2Flocalhost%3A41234%2Fauth%2Fcallback&response_type=code&state=s1-state-0001'
const ATTEMPT = '0a1b2c3d-1111-2222-3333-444455556666'
const agy = (over = {}, cli = {}) => ({
  id: 'acp-antigravity', key: 'antigravity', name: 'Antigravity', on: false, appSignIn: true,
  cli: { found: true, state: 'ready', install: 'manual', managed: true, version: '1.5.15', installUrl: 'https://antigravity.google/docs/getting-started', ...cli },
  connector: { state: 'ready', native: true }, signedIn: false,
  model: { provider: 'acp-antigravity', id: 'default', name: 'x', listed: true }, restartNeeded: false,
  ...over,
})
const MISSING = { found: false, state: 'missing', managed: false, version: undefined }
const PASTING = { on: true, signingIn: true, signInUrl: AGY_LINK, signInAttempt: ATTEMPT, signInPaste: true, signInExpiresAt: 1_800_000_000_000 }
const WINDOWS = 'On Windows, the Antigravity account is shared'
const noCommand = (text, what) => {
  for (const pattern of [/acp --login/, /env -i/, /\$env:/, /cli-homes/, /\/bin\/agy/, /agy\.exe/, /Run /, /\{/]) assert.doesNotMatch(text, pattern, what)
}
// The step with Antigravity's agent as given; `open` flips its row once (the setup opens).
async function agyStep(agent, { open = true } = {}) {
  requests.length = 0
  acpRows = [agent]
  acpAnswer = () => undefined
  const opened = []
  sandbox[BRIDGE] = { open: (provider) => { opened.push(provider); return true }, remember: () => {} }
  const run = runHook(() => ui.ConnectAiStep({ stepId: 'omni-connect-ai', complete: () => {}, openSection: () => {} }))
  await run.settle()
  if (open) {
    switchOf(render(run.current), 'Antigravity').props.onClick()
    await run.settle()
  }
  return { run, opened, tree: () => render(run.current), done: () => { delete sandbox[BRIDGE]; run.done() } }
}
const sent = (endpoint) => requests.filter(([name]) => name === endpoint)

test('Y1: the flip on the not-ready row turns acp-dsh\'s Antigravity switch on, then opens its setup; no chat', async () => {
  const step = await agyStep(agy({}, MISSING), { open: false })
  try {
    assert.ok(switchOf(step.tree(), 'Antigravity'))
    const before = requests.length
    switchOf(step.tree(), 'Antigravity').props.onClick()
    await step.run.settle()
    assert.deepEqual(requests.slice(before).filter(([name]) => name !== 'ais' && name !== 'acp'), [['acp-switch', { id: 'acp-antigravity', on: true }]])
    assert.deepEqual(sent('ai-switch'), [])
    assert.match(textOf(step.tree()), /The agy CLI is not on this computer\. Automagik can install it for you\./)
    assert.deepEqual(step.opened, [])
    assert.notEqual(step.run.current.type, ui.StepAside)
  } finally { step.done() }
  // A refused switch: the panel stays closed and the refusal shows under the row.
  const refused = await agyStep(agy({}, MISSING), { open: false })
  try {
    acpAnswer = (endpoint) => { if (endpoint === 'acp-switch') throw new Error('This DSH cannot change the ACP agents\' settings.') }
    switchOf(refused.tree(), 'Antigravity').props.onClick()
    await refused.run.settle()
    const text = textOf(refused.tree())
    assert.match(text, /This DSH cannot change the ACP agents' settings\./)
    assert.doesNotMatch(text, /Automagik can install it for you/)
  } finally { refused.done() }
})

test('Y2: the setup by state: Install, Retry, Sign in, the link with Copy and the paste field, Finishing, expired', async () => {
  const states = [
    [agy({ on: true }, MISSING), /The agy CLI is not on this computer\. Automagik can install it for you\./, 'Install', ['acp-install', { id: 'acp-antigravity' }]],
    [agy({ on: true }, { ...MISSING, state: 'installing' }), /Installing Antigravity…/],
    [agy({ on: true }, { ...MISSING, state: 'failed', error: 'offline' }), /The Antigravity installation or update failed: offline/, 'Retry', ['acp-install', { id: 'acp-antigravity' }]],
    [agy({ on: true }), /Found the agy CLI \(installed by Automagik as version 1\.5\.15; it updates itself\)\.Not signed in to Antigravity\./, 'Sign in', ['acp-sign-in', { id: 'acp-antigravity' }]],
    [agy({ on: true, signingIn: true, signInChecking: true }), /Finishing the sign-in to Antigravity…/],
    [agy({ on: true, signInError: 'expired' }), /This sign-in expired\. Start again\./, 'Sign in', ['acp-sign-in', { id: 'acp-antigravity' }]],
  ]
  for (const [agent, line, button, request] of states) {
    const step = await agyStep(agent)
    try {
      const tree = step.tree()
      assert.match(textOf(tree), line)
      assert.doesNotMatch(textOf(tree), /With your plan, in a Bot's chat|Use an API key/)
      noCommand(textOf(tree), String(line))
      if (agent.cli.state === 'failed') {
        assert.equal(findAll(tree, node => node.type === 'a' && textOf(node) === 'Install it yourself instead')[0].props.href, 'https://antigravity.google/docs/getting-started')
      }
      if (button) {
        buttons(tree, button)[0].props.onClick()
        await step.run.settle()
        assert.deepEqual(requests.findLast(([name]) => name.startsWith('acp-')), request)
      }
    } finally { step.done() }
  }
  // No link from agy (r9, lead): the chat's own sentence, never the old browser one.
  const noLink = await agyStep(agy({ on: true, signInError: 'no-browser' }))
  try {
    const text = textOf(noLink.tree())
    assert.match(text, /The CLI did not offer a sign-in link in time\. Try again\./)
    assert.doesNotMatch(text, /The browser did not open/)
    noCommand(text, 'no-browser')
  } finally { noLink.done() }
  // Signing in with a link: the link, Copy, the field and Send; Send empties the field first.
  const step = await agyStep(agy(PASTING))
  try {
    const tree = step.tree()
    assert.equal(findAll(tree, node => node.type === 'a' && node.props.href === AGY_LINK).length, 1)
    assert.equal(buttons(tree, 'Copy').length, 1)
    assert.match(textOf(tree), /Signed in on another computer\? Paste the address the browser ends on:/)
    const [form] = findAll(tree, node => node.type === 'form')
    const field = { value: 'http://localhost:41234/auth/callback?code=c&state=s1-state-0001' }
    let atRequest
    acpAnswer = (endpoint) => { if (endpoint === 'acp-sign-in-callback') atRequest = field.value }
    form.props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: () => field } } })
    await step.run.settle()
    assert.equal(atRequest, '')
    assert.deepEqual(sent('acp-sign-in-callback'), [['acp-sign-in-callback', { id: 'acp-antigravity', attempt: ATTEMPT, url: 'http://localhost:41234/auth/callback?code=c&state=s1-state-0001' }]])
    // A refusal shows in the panel's problem line; the attempt goes on.
    acpAnswer = (endpoint) => { if (endpoint === 'acp-sign-in-callback') throw new Error('This link is not from this sign-in.') }
    findAll(step.tree(), node => node.type === 'form')[0].props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: () => ({ value: 'http://x' }) } } })
    await step.run.settle()
    assert.match(textOf(step.tree()), /This link is not from this sign-in\./)
    noCommand(textOf(step.tree()), 'pasting')
  } finally { step.done() }
})

test('Y3: Cancel, or a second flip, before it is signed in turns Antigravity back off; signed in, Cancel sends nothing', async () => {
  // (a) On from Settings, not signed in: the panel opened by a flip; Cancel turns it off.
  for (const over of [{ on: true }, PASTING]) {
    const step = await agyStep(agy(over))
    try {
      buttons(step.tree(), 'Cancel')[0].props.onClick()
      await step.run.settle()
      assert.deepEqual(sent('acp-switch'), [['acp-switch', { id: 'acp-antigravity', on: false }]], JSON.stringify(over))
      assert.doesNotMatch(textOf(step.tree()), /Not signed in to Antigravity\.|Signed in on another computer/)
    } finally { step.done() }
  }
  // A second flip while its setup is open does the same.
  const twice = await agyStep(agy({ on: true }))
  try {
    switchOf(twice.tree(), 'Antigravity').props.onClick()
    await twice.run.settle()
    assert.deepEqual(sent('acp-switch'), [['acp-switch', { id: 'acp-antigravity', on: false }]])
  } finally { twice.done() }
  // Signed in (a restart pending, so the row is not on yet): Cancel only closes.
  const signed = await agyStep(agy({ on: true, signedIn: true, restartNeeded: true }))
  try {
    for (const cancel of buttons(signed.tree(), 'Cancel')) cancel.props.onClick()
    await signed.run.settle()
    assert.deepEqual(sent('acp-switch'), [])
  } finally { signed.done() }
})

test('Y4: with its setup closed (a reload) and a sign-in under way, the link, Copy and the field show under the row', async () => {
  const step = await agyStep(agy(PASTING), { open: false })
  try {
    const tree = step.tree()
    assert.equal(findAll(tree, node => node.type === 'a' && node.props.href === AGY_LINK).length, 1)
    assert.equal(buttons(tree, 'Copy').length, 1)
    assert.equal(findAll(tree, node => node.type === 'form').length, 1)
    assert.equal(buttons(tree, 'Cancel').length, 0)
  } finally { step.done() }
})

test('Y5: on Windows every state says the account is shared, and there is no Sign out', async () => {
  for (const [over, cli] of [[{ on: true }, MISSING], [{ on: true }, {}], [PASTING, {}], [{ on: true, signedIn: true, restartNeeded: true }, {}]]) {
    const step = await agyStep(agy({ ...over, sharedAccount: true }, cli))
    try {
      assert.ok(textOf(step.tree()).includes(WINDOWS), JSON.stringify(over))
      assert.equal(buttons(step.tree(), 'Sign out').length, 0)
    } finally { step.done() }
  }
})

test('Y6: the rows are read again when an agent\'s state changes, not on an answer that changes nothing', async () => {
  const step = await agyStep(agy(PASTING))
  try {
    const reads = () => sent('ais').length
    const before = reads()
    const send = () => findAll(step.tree(), node => node.type === 'form')[0].props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: () => ({ value: 'http://x' }) } } })
    send()
    await step.run.settle()
    assert.equal(reads(), before)
    // Signed in: the next answer reads the rows again.
    acpRows = [agy({ on: true, signedIn: true })]
    send()
    await step.run.settle()
    assert.equal(reads(), before + 1)
  } finally { step.done() }
})
