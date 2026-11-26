// RFC 0030, Handoff note (2026-11-23): for the person an agent switch stays one conversation,
// with a line where the new part begins, "Switched to <agent>". The ended part's segment holds
// `switchedTo`; the host's pages carry it on the divider (and beside an earlier page's
// `startedAt`); the chat, the earlier parts and the member view draw it in the part line's own
// span. A segment without it draws as it always did.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { DICTIONARY, hostText, installLocale } from '../src/client/i18n.js'
import { install as installParts } from '../src/host/parts.js'
import { fixture, member } from './caller-fixture.js'
import { bundle as viewerBundle, browser, load } from './viewer-fixture.js'

const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))

const cells = await build({
  stdin: { contents: "export { ChatRows, PartLine } from './src/client/cells.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(cells.outputFiles[0].text, {
  module, exports: module.exports, Intl, Date, TextEncoder, queueMicrotask,
  require: (name) => {
    const platform = {
      react: {
        Fragment: 'fragment', createContext: initial => ({ value: initial, Provider: ({ children }) => children }), useContext: ctx => ctx.value,
        useCallback: fn => fn, useId: () => 'id', useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [initial, () => {}], useRef: current => ({ current }), useLayoutEffect() {}, useEffect() {}, useMemo: make => make(),
      },
      'react-dom': {},
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { ChatRows, PartLine } = module.exports

const DAY = Date.UTC(2026, 10, 23, 15)
const roster = {
  byId: { b: { id: 'b', name: 'Writer' } }, roomsById: {},
  models: [
    { ref: 'acp-claude/default', provider: 'acp-claude', providerName: 'Claude Code', name: 'Default' },
    { ref: 'deepseek/v4', provider: 'deepseek', providerName: 'DeepSeek', name: 'DeepSeek V4' },
  ],
}
const lineText = line => (line.children[0] === undefined ? null : line.children[0].children.join(''))

test('the part line names the agent the chat switched to, then the day, in one span', () => {
  const plain = PartLine({ time: DAY, roster })
  const day = lineText(plain)
  assert.ok(day)
  assert.equal(plain.props.className, 'bt-part-line')
  assert.equal(plain.props.role, 'separator')
  // An agent over ACP by its brand; an agent the catalog does not list by the menu's own name;
  // a native model by its name.
  assert.equal(lineText(PartLine({ time: DAY, switchedTo: 'acp-claude/default', roster })), `Switched to Claude Code · ${day}`)
  assert.equal(lineText(PartLine({ time: DAY, switchedTo: 'acp-codex/gpt-6.2-sol', roster })), `Switched to Codex · ${day}`)
  assert.equal(lineText(PartLine({ time: DAY, switchedTo: 'deepseek/v4', roster })), `Switched to DeepSeek V4 · ${day}`)
  // One span, no new element.
  const switched = PartLine({ time: DAY, switchedTo: 'acp-claude/default', roster })
  assert.equal(switched.children.length, 1)
  assert.equal(switched.children[0].type, 'span')
  // An old segment, or a line with no time: as before.
  assert.equal(PartLine({ time: undefined, roster }).children[0] ?? null, null)
  assert.equal(lineText(PartLine({ time: undefined, switchedTo: 'acp-claude/default', roster })), 'Switched to Claude Code')
})

test('a page divider carries its switch to the part line', () => {
  const rows = [...ChatRows({ items: [{ kind: 'divider', time: DAY, switchedTo: 'acp-claude/default' }, { kind: 'user', text: 'hi', time: DAY + 1 }], sessionId: 'b', roster, actions: {} })]
  assert.equal(rows[0].type.name, 'PartLine')
  assert.equal(rows[0].props.switchedTo, 'acp-claude/default')
  assert.equal(lineText(rows[0].type(rows[0].props)).startsWith('Switched to Claude Code · '), true)
})

test('the member view draws the same line', () => {
  return viewerBundle("export { MemberRows } from './src/client/member-root.js'").then((code) => {
    const f = browser({ fetch: () => assert.fail('render fetched a resource') })
    const { MemberRows } = load(code, f.globals)
    const rows = MemberRows({ roster: { bots: [], byId: {} }, botId: 'b', pages: [[{ kind: 'divider', time: DAY, switchedTo: 'acp-claude/default' }], [{ kind: 'divider', time: DAY }]] })
    const flat = node => (Array.isArray(node) ? node.map(flat).join('') : typeof node === 'string' ? node : node?.props ? flat(node.props.children) : '')
    const texts = rows.map(flat)
    assert.equal(texts.length, 2)
    assert.match(texts.find(text => /Switched/.test(text)) ?? '', /^Switched to Claude Code · \S/)
    assert.ok(texts.some(text => text !== '' && !/Switched/.test(text)))
  })
})

// A Writer whose part b1 ended in an agent switch to Claude Code, and whose part b2 ended
// without one (an older segment).
function host({ segments }) {
  const writer = { id: 'b', name: 'Writer', createdAt: 1, sessionId: 'b3', segments }
  const rt = {
    ctx: { on() {}, effect() {}, get() {}, sessionController: { page: async () => ({ records: [{ event: { type: 'user/message', seq: 1, time: 10, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } } }], hasMore: false }) } },
    config: {},
    state: { exchangeTurns: {} },
    chatOwners: new Map([['b3', 'b']]),
    pastOwners: new Map([['b1', { botId: 'b' }], ['b2', { botId: 'b' }]]),
    botOf: id => (id === 'b' ? writer : undefined),
    roomOf: () => undefined,
    chatOf: () => 'b3',
    resolveAgent: async id => ({ session: { id, seq: 3 } }),
  }
  installParts(rt)
  return rt
}

test('the host marks where a switch opened a part, on the divider and beside an earlier page', async () => {
  const rt = host({ segments: [{ sessionId: 'b1', endedAt: 2, switchedTo: 'acp-claude/default' }, { sessionId: 'b2', endedAt: 3 }] })
  const parts = rt.partsOf('b')
  assert.deepEqual(parts.map(part => part.switchedIn ?? null), [null, 'acp-claude/default', null])
  // The current part b3 opened after b2, which ended without a switch.
  const current = await rt.earlierPage('b3')
  assert.equal(current.switchedTo, null)
  assert.deepEqual(current.items[0], { kind: 'divider', time: 2, switchedTo: 'acp-claude/default' })
  // Part b2 opened with the switch: its page's divider says so; part b1 has no divider.
  const older = await rt.earlierPage('b3', { part: 0 })
  assert.equal(older.items[0].kind, 'user')
  // From b2's own view, the part before it is b1 and b2 itself began with the switch.
  rt.pastOwners.set('b2', { botId: 'b' })
  const fromB2 = await rt.earlierPage('b2')
  assert.equal(fromB2.switchedTo, 'acp-claude/default')
  // Without a switch on any segment nothing changes.
  const plain = host({ segments: [{ sessionId: 'b1', endedAt: 2 }, { sessionId: 'b2', endedAt: 3 }] })
  assert.deepEqual((await plain.earlierPage('b3')).items[0], { kind: 'divider', time: 2 })
  assert.equal((await plain.earlierPage('b3')).switchedTo, null)
})

test('the member view of a shared Bot carries the switch on its divider', async (t) => {
  const f = fixture(t)
  await f.start()
  const first = await f.open()
  f.event(first, 'turn/start', { turn: 1 })
  f.event(first, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] })
  await f.rt.startFresh('b')
  await f.finishSwitch()
  const second = f.rt.chatOf('b')
  f.event(second, 'turn/start', { turn: 1 })
  f.event(second, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'second' }] })
  const segment = f.rt.botOf('b').segments.find(item => item.sessionId === first)
  assert.equal((await f.rt.callerChat(member, 'b')).items[0].kind, 'divider')
  assert.equal(Object.hasOwn((await f.rt.callerChat(member, 'b')).items[0], 'switchedTo'), false)
  segment.switchedTo = 'acp-claude/default'
  const page = await f.rt.callerChat(member, 'b')
  assert.equal(page.items[0].kind, 'divider')
  assert.equal(page.items[0].switchedTo, 'acp-claude/default')
})

test('the switch copy is worded in zh and pt-BR, and the host\'s running-reply refusal reads in each', () => {
  for (const key of ['Switched to {agent}', 'Switching to {agent}…', 'This stops the current reply and continues on {agent}.']) {
    assert.ok(DICTIONARY.zh[key], key)
    assert.ok(pt[key], key)
    assert.match(DICTIONARY.zh[key], /\{agent\}/)
    assert.match(pt[key], /\{agent\}/)
  }
  // The two dropped keys of an earlier plan are not added.
  for (const key of [
    'Changing the route keeps this conversation: the new model starts from a summary and the latest messages, and can read the rest of the chat.',
    'This conversation is moving to another agent.',
  ]) {
    assert.equal(DICTIONARY.zh[key], undefined, key)
    assert.equal(pt[key], undefined, key)
  }
  const message = 'This stops the current reply and continues on Claude Code.'
  for (const [active, dictionary] of [['pt-BR', pt], ['zh', DICTIONARY.zh]]) {
    const dispose = installLocale({
      register: () => () => {},
      getLocale: () => ({ active }),
      bind: () => (key, params) => (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, param) => params?.[param] ?? _),
    })
    try {
      const worded = hostText(message)
      assert.notEqual(worded, message, active)
      assert.match(worded, /Claude Code/, active)
    } finally {
      dispose()
    }
  }
})
