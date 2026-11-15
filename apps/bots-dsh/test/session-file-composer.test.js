import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const plugin = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(join(process.env.DSH_HARNESS, 'package.json'))
const { JSDOM, VirtualConsole } = require('jsdom')
// Execute apply's real surface installers, shadow and freePriority, without starting
// polling, transport or an app. Export component identities from the same bundle.
const { outputFiles } = await build({
  stdin: { contents: [
    "export { apply, omni } from './src/client/index.js'",
    "export { SessionFileApproval } from './src/client/session-file-approval.js'",
    "export { QuestionCard } from './src/client/questions.js'",
    "export { TeamApproval } from './src/client/team-approval.js'",
  ].join('\n'), resolveDir: plugin },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const COMPOSER = 'conversation.composer'
const ALLOW = 'Allow for this chat session'
const question = () => ({
  id: 'acp-session-file:01234567-1234-1234-1234-0123456789ab',
  question: 'Read /outside/image.png for this chat session?',
  detail: 'Read /outside/image.png for this chat session? No sibling access; send a new message after allowing.',
  options: [{ label: ALLOW }, { label: 'Reject' }],
  intent: { kind: 'approval', approve: ALLOW, reject: 'Reject' },
})
const pendingQuestion = (item = question()) => ({ kind: 'question', questions: [item] })

function start(t, { externalPriority, delayed = false } = {}) {
  const domErrors = [], virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', error => domErrors.push(error))
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', virtualConsole })
  const effects = new Map(), entries = [], injections = new Set(), timers = new Map()
  let sequence = 0, timer = 0, declared = !delayed
  const schedule = fn => { timers.set(++timer, fn); return timer }
  const cancel = id => timers.delete(id)
  const slots = {
    entries: name => entries.filter(entry => entry.options.name === name),
    register(options, component) {
      const entry = { options, component, sequence: sequence++ }
      entries.push(entry)
      return () => { const index = entries.indexOf(entry); if (index !== -1) entries.splice(index, 1) }
    },
    inject(name, install) {
      const injection = { name, install, dispose: undefined }
      injections.add(injection)
      if (name !== COMPOSER || declared) injection.dispose = install()
      return () => { injection.dispose?.(); injections.delete(injection) }
    },
    subscribe: () => () => {},
  }
  // Native and external entries survive withdrawal of the Bot surface.
  const NativeComposer = () => 'native'
  slots.register({ name: COMPOSER, priority: 0, select: owner => owner }, NativeComposer)
  if (externalPriority !== undefined) slots.register({ name: COMPOSER, priority: externalPriority, select: () => null }, () => 'external')
  const originalEntries = [...entries]
  const source = value => ({ getSnapshot: () => value, subscribe: () => () => {} })
  const ctx = {
    effect: (fn, label) => { effects.set(label, fn); return () => {} },
    inject: () => ({ dispose() {} }), get: () => undefined,
    sessions: { list: source({ ids: ['chat'], byId: { chat: { id: 'chat', retainedBy: { mainView: 1 } } } }) },
    uiWorkspace: {}, uiConversation: {}, layout: { panelInfo: source({}) },
    theme: { overrideTokens: () => () => {} }, slots,
  }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    require: name => name.startsWith('react') ? new Proxy({}, { get: () => () => null }) : {},
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    navigator: dom.window.navigator, Element: dom.window.Element, MutationObserver: dom.window.MutationObserver,
    HTMLLinkElement: dom.window.HTMLLinkElement,
    setTimeout: schedule, clearTimeout: cancel, requestAnimationFrame: schedule, cancelAnimationFrame: cancel,
    fetch: () => assert.fail('registration regression must not use transport'), console, URL, AbortController,
  })
  const api = module.exports
  api.apply(ctx)
  const offFace = effects.get('ds-bot: face for other Omni plugins')()
  const offSurface = effects.get('ds-bot: surface')()
  const face = api.omni.face()
  t.after(() => { offSurface(); offFace(); dom.window.close(); assert.deepEqual(domErrors, []) })
  const declare = () => {
    declared = true
    // Declaration invokes each waiting callback synchronously in insertion order,
    // so every real freePriority call sees the preceding registration.
    for (const injection of injections) if (injection.name === COMPOSER && !injection.dispose) injection.dispose = injection.install()
  }
  const elect = pendingInteraction => {
    const owner = { pendingInteraction }
    for (const entry of slots.entries(COMPOSER).sort((a, b) => a.options.priority - b.options.priority || a.sequence - b.sequence)) {
      const matched = entry.options.select(owner)
      if (matched !== null) return { ...entry, matched }
    }
    assert.fail('native composer fallback missing')
  }
  return { ...api, slots, face, elect, declare, NativeComposer, originalEntries, injections }
}

for (const externalPriority of [undefined, -200]) {
  for (const delayed of [false, true]) {
    test(`real composer chain elects session approval (external=${externalPriority ?? 'none'}, delayed=${delayed})`, async t => {
      const bench = start(t, { externalPriority, delayed })
      if (delayed) {
        assert.deepEqual(bench.slots.entries(COMPOSER), bench.originalEntries)
        bench.declare()
      }
      const item = question(), pending = pendingQuestion(item)
      const elected = bench.elect(pending)
      assert.equal(elected.component, bench.SessionFileApproval, 'strict session approval must beat the generic QuestionCard')
      assert.equal(elected.matched.pending, pending)
      assert.equal(elected.matched.item, item)
      const botEntries = bench.slots.entries(COMPOSER).filter(entry => !bench.originalEntries.includes(entry))
      assert.deepEqual(botEntries.map(entry => entry.component), [bench.QuestionCard, bench.TeamApproval, bench.SessionFileApproval])
      assert.deepEqual(botEntries.map(entry => entry.options.priority), externalPriority === undefined ? [-100, -101, -102] : [-201, -202, -203])
      assert.equal(typeof botEntries[1].options.inject, 'function', 'team keeps its existing face injection')
      // Each answer settles a distinct request. Model the blocking PendingQuestion's
      // waterfall/none channels and one-way close; the host still owns authorization.
      for (const [action, label] of [['onAllow', ALLOW], ['onReject', 'Reject']]) {
        let snapshot = { channel: 'waterfall', closed: false }, factory
        const answers = []
        const request = {
          ...pending, key: `chat/nonce-request/${action}`, snapshot: () => snapshot,
          answer(answer) {
            assert.equal(this, request)
            assert.equal(snapshot.closed, false)
            answers.push(answer)
            snapshot = { channel: 'none', closed: true }
          },
        }
        const winner = bench.elect(request)
        assert.equal(winner.component, bench.SessionFileApproval)
        assert.equal(winner.matched.pending, request)
        const rendered = winner.component({ matched: winner.matched, renderFactorySlot: (name, props) => (factory = { name, props }) })
        assert.equal(rendered, factory)
        assert.equal(factory.name, 'conversation.approval.card')
        assert.equal(factory.props.requestKey, request.key)
        assert.equal(factory.props.title, item.question)
        assert.equal(factory.props.description, item.detail)
        assert.equal(factory.props.allowLabel, ALLOW)
        assert.equal('onAlways' in factory.props, false)
        assert.equal(factory.props.canAnswer(), true)
        snapshot = { channel: 'none', closed: false }; assert.equal(factory.props.canAnswer(), false)
        snapshot = { channel: 'waterfall', closed: false }; assert.equal(factory.props.canAnswer(), true)
        await factory.props[action]()
        assert.deepEqual(JSON.parse(JSON.stringify(answers)), [{ answers: [{ id: item.id, selected: [label] }] }])
        assert.equal(factory.props.canAnswer(), false)
        snapshot = { channel: 'waterfall', closed: true }; assert.equal(factory.props.canAnswer(), false)
      }

      bench.face.actions.setSurface('agent')
      assert.deepEqual(bench.slots.entries(COMPOSER), bench.originalEntries, 'all Bot entries are disposed')
      assert.equal([...bench.injections].some(entry => entry.name === COMPOSER), false)
      assert.equal(bench.elect(pending).component, bench.NativeComposer)
      bench.face.actions.setSurface('bot')
      assert.equal(bench.elect(pending).component, bench.SessionFileApproval)
      assert.deepEqual(bench.slots.entries(COMPOSER).map(entry => entry.options.priority), [...bench.originalEntries.map(entry => entry.options.priority), ...botEntries.map(entry => entry.options.priority)], 'remount neither leaks nor ratchets priorities')
    })
  }
}

test('real composer chain preserves ordinary questions, strict near misses, team and native fallbacks', t => {
  const bench = start(t, { externalPriority: -200 })
  const ordinary = pendingQuestion({ id: 'ordinary', question: 'Pick a colour', options: [{ label: 'Blue' }] })
  assert.equal(bench.elect(ordinary).component, bench.QuestionCard)
  assert.equal(bench.elect(ordinary).matched, ordinary)
  const nearMisses = [
    q => { delete q.intent }, q => { q.id = 'acp-session-file:not-a-nonce' },
    q => { q.id = 'cua-app-access' }, q => { q.intent.kind = 'plan-review' },
    q => { q.intent.approve = 'Allow once' }, q => { q.intent.reject = 'Deny' },
    q => { q.intent.always = 'Always' }, q => { q.multiSelect = false }, q => { q.multiSelect = true },
    q => { delete q.detail }, q => { q.detail = '' }, q => { q.detail = 42 },
    q => { q.options.reverse() }, q => { q.options.push({ label: 'Always' }) },
  ]
  for (const change of nearMisses) {
    const item = question(); change(item)
    const pending = pendingQuestion(item)
    assert.equal(bench.elect(pending).component, bench.QuestionCard)
    assert.equal(bench.elect(pending).matched, pending)
  }
  for (const questions of [[], [question(), question()]]) assert.equal(bench.elect({ kind: 'question', questions }).component, bench.QuestionCard)
  const team = { kind: 'approval', toolName: 'mcp__dsh__message_bot' }
  assert.equal(bench.elect(team).component, bench.TeamApproval)
  assert.equal(bench.elect(team).matched, team)
  for (const pending of [undefined, null, { kind: 'approval', toolName: 'bash' }, { kind: 'plan-review' }]) {
    assert.equal(bench.elect(pending).component, bench.NativeComposer)
  }
})
