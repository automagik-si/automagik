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
