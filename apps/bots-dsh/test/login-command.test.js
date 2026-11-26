import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { t } from '../src/client/i18n.js'
import { createSource, EMPTY_ROSTER, indexRoster } from '../src/client/sources.js'
import { groupsFor, surfaceGroups } from '../src/client/surface.js'

// DSH provides these platform modules in the browser. The stand-ins let the test inspect the
// existing row's elements without a browser or a second React installation.
const { outputFiles } = await build({
  stdin: {
    contents: [
      readFileSync(new URL('../src/client/cli-login.js', import.meta.url), 'utf8'),
      'export { CliLoginRow }',
      "export * from './login-command.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, external: ['react', 'react-dom'],
})
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require(name) {
    if (name === 'react') return { createElement: (type, props, ...children) => ({ type, props, children }), useLayoutEffect() {} }
    if (name === 'react-dom') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { CliLoginRow, installLoginCommand, loginCommand, loginRoute } = module.exports

const loading = 'Your team is still loading. Try /login again in a moment.'
// #2048: Antigravity signs in from the chat too, so the notice names it.
const setupAI = 'Sign-in from the chat is for Claude Code, Codex and Antigravity. Set up this AI in Settings.'
const setup = provider => `Sign-in from the chat is for Claude Code, Codex and Antigravity. Set up ${provider} in Settings.`

function fixture({ open = true } = {}) {
  const bots = [
    { id: 'claude', sessionId: 'current-part', parts: ['claude', 'current-part'], model: 'acp-claude/default', appliedModel: 'openrouter/default' },
    { id: 'codex', appliedModel: 'acp-codex/default' },
    { id: 'agy', model: 'acp-antigravity/default' },
    { id: 'unconfigured' },
    { id: 'host', model: 'acp-codex/default' },
    { id: 'adopted', kind: 'dsh', model: 'acp-codex/default' },
    ...['deepseek-account', 'kimi-coding', 'github-copilot', 'xai', 'openrouter', 'openai-codex']
      .map(id => ({ id, model: `${id}/default` })),
  ]
  const ready = indexRoster({
    bots,
    rooms: [{ id: 'room', sessionId: 'room-part' }],
    agents: [{ id: 'native', sessions: ['plain'] }],
    hostModels: { host: { models: [] } },
    models: [
      { provider: 'other', ref: 'other/default', providerName: 'Other provider' },
      { provider: 'openrouter', ref: 'openrouter/another-model', providerName: 'OpenRouter' },
      { ref: 'deepseek-account/default', providerName: 'DeepSeek' },
    ],
  })
  const roster = createSource(ready)
  const calls = []
  const actions = {
    openCliLogin: (...args) => { calls.push(['open', ...args]); return open },
    showNotice: text => calls.push(['notice', text]),
    signIn: () => assert.fail('chat sign-in only opens the CLI row'),
    openHarnessOnboarding: () => assert.fail('other providers are directed to Settings'),
  }
  return { ready, roster, actions, calls, command: loginCommand({ roster, actions, t }) }
}

test('/login opens the existing Claude or Codex row by Bot id without a model ref', () => {
  const { roster, actions, calls, command } = fixture()
  assert.deepEqual({ ...loginRoute({ roster: roster.getSnapshot(), sessionId: 'current-part', actions }) },
    { kind: 'cli', botId: 'claude', provider: 'acp-claude' })
  assert.deepEqual(calls, [], 'routing is pure')
  command.ui.run({ sessionId: 'current-part' })
  command.ui.run({ sessionId: 'codex' })
  assert.deepEqual(calls, [['open', 'claude', 'acp-claude'], ['open', 'codex', 'acp-codex']])
})

test('/login opens Antigravity\'s row too, by Bot id (#2048, parity)', () => {
  const { roster, actions, calls, command } = fixture()
  assert.deepEqual({ ...loginRoute({ roster: roster.getSnapshot(), sessionId: 'agy', actions }) }, { kind: 'cli', botId: 'agy', provider: 'acp-antigravity' })
  command.ui.run({ sessionId: 'agy' })
  assert.deepEqual(calls, [['open', 'agy', 'acp-antigravity']])
})

test('/login shows the generic Settings notice if the existing CLI entry declines', () => {
  const { calls, command } = fixture({ open: false })
  command.ui.run({ sessionId: 'codex' })
  assert.deepEqual(calls, [['open', 'codex', 'acp-codex'], ['notice', setupAI]])
})

test('/login gives group, missing model, host menu and provider-specific notices', () => {
  const { calls, command } = fixture()
  for (const sessionId of ['room-part', 'unconfigured', 'host', 'deepseek-account', 'kimi-coding', 'github-copilot', 'xai', 'openrouter', 'openai-codex']) {
    command.ui.run({ sessionId })
  }
  assert.deepEqual(calls, [
    ['notice', "Sign-in runs in a Bot's chat. Open the Bot whose AI you want to sign in."],
    ['notice', 'Choose an AI for this Bot first.'],
    ['notice', setupAI],
    ...['DeepSeek', 'kimi-coding', 'github-copilot', 'xai', 'OpenRouter', 'openai-codex']
      .map(provider => ['notice', setup(provider)]),
  ])
})

test('/login claims the loading gap, then is available only for Bot and group chats', () => {
  const { ready, roster, calls, command } = fixture()
  assert.equal(command.name, 'login')
  assert.equal(command.label(), 'Sign in')
  assert.equal(command.description(), "Sign in to this chat's AI provider")
  assert.equal(command.ui.kind, 'action')
  assert.equal(command.icon, undefined)
  roster.set(EMPTY_ROSTER)
  assert.equal(command.available({ sessionId: 'plain' }), true)
  assert.equal(command.ui.run({ sessionId: 'codex' }), undefined)
  assert.deepEqual(calls, [['notice', loading]])
  roster.set(ready)
  for (const sessionId of ['plain', 'adopted', 'unknown']) {
    assert.equal(command.available({ sessionId }), false)
    command.ui.run({ sessionId })
  }
  assert.deepEqual(calls, [['notice', loading]], 'the earlier invocation did not wait')
  for (const sessionId of ['current-part', 'room-part']) assert.equal(command.available({ sessionId }), true)
  command.ui.run({ sessionId: 'codex' })
  assert.deepEqual(calls, [['notice', loading], ['open', 'codex', 'acp-codex']])
})

test('the conversation installer registers and withdraws /login through the commandUi scope', () => {
  const { roster, actions } = fixture()
  const registered = new Map()
  const ctx = {
    inject(names, install) {
      assert.deepEqual([...names], ['commandUi'])
      const disposers = []
      install({
        commandUi: {
          register(command) {
            assert.equal(registered.has(command.name), false)
            registered.set(command.name, command)
            return () => registered.delete(command.name)
          },
        },
        effect: fn => disposers.push(fn()),
      })
      return { dispose: () => disposers.forEach(off => off()) }
    },
  }
  const groups = surfaceGroups({
    shell: () => [],
    conversation: () => [() => installLoginCommand(ctx, { roster, actions, t })],
  })
  groups.reconcile(groupsFor({ mode: 'bot' }))
  assert.equal(registered.get('login').available({ sessionId: 'codex' }), true)
  groups.reconcile(groupsFor({ mode: 'agent' }))
  assert.equal(registered.size, 0)
  groups.reconcile(groupsFor({ mode: 'bot' }))
  assert.deepEqual([...registered.keys()], ['login'])
  groups.reconcile(groupsFor({ mode: 'bot', plain: true }))
  assert.equal(registered.size, 0)
})

test('the ready row renders the account, API key or generic completion sentence', () => {
  for (const [fields, sentence] of [
    [{ signedInAs: { kind: 'account', email: 'dev@example.test', org: 'Example', plan: 'team' } }, 'Done: signed in to Codex as dev@example.test (Example, team).'],
    [{ signedInAs: { kind: 'key' } }, 'Done: Codex uses an API key.'],
    [{ signedInAs: { kind: 'account' } }, 'Done: signed in to Codex.'],
    [{}, 'Done: signed in to Codex.'],
    [{ taken: true }, 'Done: Bots will use this Codex account.'],
  ]) {
    const row = { provider: 'acp-codex', stage: 'done', ...fields }
    const rendered = CliLoginRow({ row })
    const paragraph = rendered.children[1].children[0]
    assert.equal(paragraph.type, 'p')
    assert.equal(paragraph.children[0], sentence)
  }
})

// #2064: Switch account. Function components in the row are run in place, so their text shows.
const nodesOf = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) nodesOf(child, out); return out }
  if (!node || typeof node !== 'object') return out
  out.push(node)
  if (typeof node.type === 'function') nodesOf(node.type({ ...node.props }), out)
  nodesOf(node.children, out)
  return out
}
const textsOf = node => nodesOf(node).flatMap(entry => (entry.children ?? []).filter(child => typeof child === 'string'))
const buttonsOf = node => nodesOf(node).filter(entry => entry.type === 'button')
  .map(entry => ({ label: entry.children[0], onClick: entry.props.onClick, disabled: entry.props.disabled, className: entry.props.className }))
function rowManager() {
  const calls = []
  const manager = Object.fromEntries(['start', 'dismiss', 'askSwitch', 'switchAgain', 'keepAttempt', 'askCancel', 'cancel']
    .map(name => [name, (...args) => { calls.push([name, ...args]) }]))
  return { calls, manager }
}
const UNCHANGED = 'The account did not change. Try again.'

test('a Switch that ended on the same account says so, before the API key line (B3)', () => {
  for (const [fields, sentence] of [
    [{ signedInAs: { kind: 'account', email: 'dev@example.test', org: 'Example', plan: 'team' } }, 'The account did not change: Codex is still signed in as dev@example.test (Example, team).'],
    [{ signedInAs: { kind: 'account' } }, 'The account did not change: Codex is still signed in to the same account.'],
    [{}, 'The account did not change: Codex is still signed in to the same account.'],
    [{ signedInAs: { kind: 'key', email: 'dev@example.test' } }, 'The account did not change: Codex is still signed in to the same account.'],
  ]) {
    const rendered = CliLoginRow({ row: { provider: 'acp-codex', stage: 'done', sameAccount: true, ...fields } })
    const paragraph = rendered.children[1].children[0]
    assert.equal(paragraph.type, 'p')
    assert.equal(paragraph.children[0], sentence)
  }
})

test('a failed switch still signed in: Try again asks, and the question names nothing else (B11, B17)', () => {
  const bot = { id: 'a' }
  const { calls, manager } = rowManager()
  const row = { provider: 'acp-codex', stage: 'failed', switched: true, stillSignedIn: true, message: UNCHANGED }
  let rendered = CliLoginRow({ bot, row, manager })
  assert.deepEqual(textsOf(rendered).slice(1), [UNCHANGED, 'Try again', 'Close'])
  let buttons = buttonsOf(rendered)
  assert.deepEqual(buttons.map(button => button.label), ['Try again', 'Close'])
  buttons[0].onClick()
  buttons[1].onClick()
  assert.deepEqual(calls, [['askSwitch', 'a'], ['dismiss', 'a']])
  calls.length = 0
  rendered = CliLoginRow({ bot, row: { ...row, confirm: true }, manager })
  assert.deepEqual(textsOf(rendered).slice(1), ['This stops running Bot work for this account. Continue?', 'Continue', 'Cancel'])
  buttons = buttonsOf(rendered)
  assert.deepEqual(buttons.map(button => [button.label, button.className]), [['Continue', 'bt-q-submit'], ['Cancel', 'bt-soft bt-soft-sm']])
  buttons[0].onClick()
  buttons[1].onClick()
  assert.deepEqual(calls, [['switchAgain', 'a'], ['keepAttempt', 'a']])
  // A host refusal stays under the question.
  rendered = CliLoginRow({ bot, row: { ...row, confirm: true, error: 'The Bot account is changing.' }, manager })
  assert.ok(textsOf(rendered).includes('The Bot account is changing.'))
  // Not a switch: today's Try again, a sign-in.
  calls.length = 0
  buttonsOf(CliLoginRow({ bot, row: { provider: 'acp-codex', stage: 'failed', message: 'Sign-in did not finish. Try again.' }, manager }))[0].onClick()
  assert.deepEqual(calls, [['start', 'a']])
})

test('a failed switch signed out: the row says so and offers Sign in (B17)', () => {
  const bot = { id: 'a' }
  const { calls, manager } = rowManager()
  const failure = 'Sign-in did not finish. Try again.'
  const rendered = CliLoginRow({ bot, row: { provider: 'acp-codex', stage: 'failed', switched: true, stillSignedIn: false, message: failure }, manager })
  assert.deepEqual(textsOf(rendered).slice(1), [failure, 'To use Codex in this Bot, sign in to your account.', 'Sign in', 'Close'])
  const buttons = buttonsOf(rendered)
  assert.deepEqual(buttons.map(button => button.label), ['Sign in', 'Close'])
  buttons[0].onClick()
  buttons[1].onClick()
  assert.deepEqual(calls, [['start', 'a'], ['dismiss', 'a']])
})

test('a settling switch draws the preparing words and a disabled cancel, no new text (B16)', () => {
  const { manager } = rowManager()
  const attempt = { id: 'acp-codex', attemptId: 'attempt_000000000000000000000002', status: 'expired', fresh: true, settling: true }
  const rendered = CliLoginRow({ bot: { id: 'a' }, roster: {}, row: { provider: 'acp-codex', stage: 'attempt', busy: true, attempt }, manager })
  assert.deepEqual(textsOf(rendered).slice(1), ['Preparing your sign-in…', 'Cancel sign-in'])
  assert.deepEqual(buttonsOf(rendered).map(button => [button.label, button.disabled]), [['Cancel sign-in', true]])
})

test('the Bot settings card hands the switch\'s own attempt to the sign-in row (B14)', async () => {
  const built = await build({
    stdin: { contents: "export { CliAccounts } from './cli-accounts.js'", resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)) },
    bundle: true, format: 'cjs', platform: 'browser', write: false, external: ['react', 'react-dom'],
  })
  // A stand-in React that keeps one component's hook slots across renders.
  let slots = []
  let cursor = 0
  const effects = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const i = cursor++
      if (slots[i] === undefined) slots[i] = { v: typeof initial === 'function' ? initial() : initial }
      const slot = slots[i]
      return [slot.v, value => { slot.v = typeof value === 'function' ? value(slot.v) : value }]
    },
    useRef(initial) { const i = cursor++; if (slots[i] === undefined) slots[i] = { current: initial }; return slots[i] },
    useEffect(effect, deps) {
      const i = cursor++
      if (slots[i] === undefined || deps.some((dep, j) => !Object.is(dep, slots[i].deps[j]))) { slots[i] = { deps }; effects.push(effect) }
    },
  }
  const card = { exports: {} }
  runInNewContext(built.outputFiles[0].text, { module: card, exports: card.exports, require: name => (name === 'react' ? react : {}) })
  const { CliAccounts } = card.exports
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)) }
  for (const [answer, opened] of [
    [{ id: 'acp-codex', attemptId: 'attempt_000000000000000000000002', status: 'failed', fresh: true, signedIn: false }, ['open', 'a', 'acp-codex', undefined, 'attempt_000000000000000000000002']],
    [{ id: 'acp-codex', signedIn: false }, ['open', 'a', 'acp-codex']],
  ]) {
    slots = []
    const calls = []
    const actions = {
      cliLoginAccounts: async () => ({ accounts: { 'acp-codex': { authScope: 'isolated', signedIn: true, account: { email: 'bot@example.test' } } } }),
      cliLoginSwitch: async (...args) => { calls.push(['switch', ...args]); return answer },
      refreshModels: async () => { calls.push(['refresh']) },
      openCliLogin: (...args) => { calls.push(['open', ...args]); return true },
    }
    const render = () => { cursor = 0; const tree = CliAccounts({ bot: { id: 'a' }, actions }); for (const effect of effects.splice(0)) effect(); return tree }
    render()
    await settle()
    buttonsOf(render()).find(button => button.label === 'Switch account').onClick()
    buttonsOf(render()).find(button => button.label === 'Continue').onClick()
    await settle()
    assert.deepEqual(calls, [['switch', 'a', 'acp-codex'], ['refresh'], opened])
  }
})

test('the chat bridge passes a switch\'s attempt to the row it opens; a plain open passes none (B14)', () => {
  const { installCliLoginBridge } = module.exports
  const scope = {}
  const opened = []
  const off = installCliLoginBridge({ scope, selectedBot: () => ({ id: 'a' }), mainBot: () => undefined,
    openLogin: (...args) => { opened.push(args); return true } })
  const bridge = scope[Symbol.for('automagik.cli-login')]
  assert.equal(bridge.open('acp-codex', { attemptId: 'attempt_000000000000000000000002' }), true)
  assert.equal(bridge.open('acp-claude'), true)
  assert.equal(bridge.open('acp-claude', undefined), true)
  assert.deepEqual(opened, [['a', 'acp-codex', 'attempt_000000000000000000000002'], ['a', 'acp-claude', undefined], ['a', 'acp-claude', undefined]])
  off()
})
