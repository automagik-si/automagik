import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { defaultShape } from '../src/client/characters.js'
import { readFileSync } from 'node:fs'

const bundle = await build({
  stdin: { contents: "export * from './cells.js'; export { installLocale } from './i18n.js'", resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, Intl, Date, TextEncoder,
  require: (name) => {
    const platform = {
      react: { Fragment: 'fragment', createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx }, useContext: ctx => ctx.value, useCallback: fn => fn, useId: () => 'dv-id', useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(), 
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [initial, () => {}], useRef: current => ({ current }),
        useLayoutEffect() {}, useEffect() {}, useMemo: make => make(),
      },
      'react-dom': {},
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
  queueMicrotask,
})
const { ChatRows, installLocale, registerSkillActivity, SkillActivityCell, SkillNoticeCell, ThinkingRow, syncGroupChains } = module.exports

const roster = { byId: { b: { id: 'b', name: 'Writer' } }, roomsById: {} }
const MINUTE = 60_000
const shape = rows => [...rows].map(row => (row.props.className === 'bt-time-sep' ? 'clock' : row.type.name === 'Bubbles' ? `bot:${row.props.texts.join('+')}` : row.type.name))

test('a Bot\'s messages in a row are one block', () => {
  const items = [
    { kind: 'user', text: 'hi', time: MINUTE },
    { kind: 'bot', text: 'one', time: 2 * MINUTE },
    { kind: 'bot', text: 'two', time: 2 * MINUTE },
    { kind: 'user', text: 'and?', time: 3 * MINUTE },
    { kind: 'bot', text: 'three', time: 4 * MINUTE },
  ]
  assert.deepEqual(shape(ChatRows({ items, sessionId: 'b', roster, actions: {} })), ['EarlierUser', 'bot:one+two', 'EarlierUser', 'bot:three'])
})

test('the private Skills remedy is visible in current and earlier Bot chat', () => {
  const kind = 'automagik-skill-notice'
  const text = "The skill amber is not active on this Bot. Add it in the Bot's Details, under Skills."
  const live = SkillNoticeCell({ node: { data: { source: { kind }, content: [{ type: 'text', text }] } } })
  const [earlier] = ChatRows({ items: [{ kind, text }], sessionId: 'b', roster, actions: {} })
  for (const cell of [live, earlier]) {
    const rendered = cell.type(cell.props)
    assert.equal(rendered.props.role, 'status')
    assert.equal(rendered.children.join(''), text)
  }
  const other = SkillNoticeCell({ node: { data: { source: { kind: 'runtime-context' } } } })
  assert.equal(other.type.name, 'CellEmpty')
})

test('the Antigravity OFF Skills notice is localized in current and earlier Bot chat', t => {
  const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url)))
  t.after(installLocale({ register() {}, bind: () => key => pt[key] ?? key }))
  const kind = 'automagik-skill-notice'
  const text = 'Skills cannot be loaded in Antigravity with native tools off on this version'
  const live = SkillNoticeCell({ node: { data: { source: { kind }, content: [{ type: 'text', text }] } } })
  const [earlier] = ChatRows({ items: [{ kind, text }], sessionId: 'b', roster, actions: {} })
  for (const cell of [live, earlier]) {
    const rendered = cell.type(cell.props)
    assert.equal(rendered.props.role, 'status')
    assert.equal(rendered.children.join(''), 'Nesta versão do Antigravity, não é possível carregar skills com as ferramentas nativas desligadas')
  }
})

test('Skill activity renders outside bubbles before an answer, in both layouts and loaded relay history', () => {
  const event = { type: 'plugin:automagik/skill-activity', ignorable: true, seq: 3, time: 4,
    data: { id: 'receipt', name: 'mint', turn: 1, step: 0 } }
  let definition
  registerSkillActivity({ uiConversation: { events: { register(value) { definition = value } } } })
  const start = { event, location: { kind: 'step' } }
  const matcher = definition.match[event.type]
  assert.equal(matcher(event).id, event.data.id)
  assert.equal(matcher({ ...event, data: { ...event.data, roomId: 'room' } }), null)
  const node = definition.buildViewNode({ key: 'row', id: event.data.id, start, state: definition.start({}, start) })
  assert.equal(node.anchorSeq, event.seq)
  assert.equal(node.location, start.location)
  const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url)))
  const translate = (dictionary) => installLocale({ register() {}, bind: () => (key, params) => (dictionary[key] ?? key).replace('{name}', params.name) })
  const rendered = cell => {
    while (typeof cell.type === 'function') cell = cell.type(cell.props)
    assert.equal(cell.props.className, 'bt-agent-activity')
    const [line] = cell.children
    assert.equal(line.props.className, 'bt-agent-act')
    return line.children.at(-1).children.join('')
  }
  for (const [dictionary, label] of [[{}, 'Skill: mint'], [pt, 'Habilidade: mint']]) {
    const release = translate(dictionary)
    try {
      for (const layout of ['flat', 'bubble']) {
        const view = { ...roster, exchangeTurns: {}, prefs: { layout } }
        const useRoster = read => read(view)
        assert.equal(rendered(SkillActivityCell({ node, sessionId: 'b', useRoster })), label)
        assert.equal(rendered(ChatRows({ items: [node.data], sessionId: 'b', roster: view, actions: {} })[0]), label)
        assert.equal(rendered(ChatRows({ items: [{ kind: 'relay', reply: { kind: 'skill-activity', botId: 'b', skill: 'mint' } }], sessionId: 'room', roster: view, actions: {} })[0]), label)
        view.exchangeTurns.b = [1]
        assert.equal(SkillActivityCell({ node, sessionId: 'b', useRoster }).type.name, 'CellEmpty')
      }
    } finally { release() }
  }
})

test('a view row renders as a view card from its blueprint', () => {
  const items = [
    { kind: 'user', text: 'show me', time: MINUTE },
    { kind: 'view', title: 'A long note', view: { type: 'stack', children: [0, 1, 2, 3].map(() => ({ type: 'text', text: 'x'.repeat(1900) })) }, callId: 'c1', time: 2 * MINUTE },
    { kind: 'bot', text: 'done', time: 3 * MINUTE },
  ]
  const rows = [...ChatRows({ items, sessionId: 'b', roster, actions: {} })]
  assert.deepEqual(shape(rows), ['EarlierUser', 'WidgetCell', 'bot:done'])
  // The card draws the blueprint, not nothing: run the cell and look inside.
  const cell = rows[1]
  const rendered = cell.type(cell.props)
  assert.equal(rendered.props.className, 'bt-q-inline')
})

test('archived chat marks resolve live identities and keep the catalogue look for missing speakers', () => {
  const items = [
    { kind: 'event', botId: 'b', role: 'reply' },
    { kind: 'post', botId: 'b', text: 'Reply' },
    { kind: 'relay', reply: { botId: 'b', kind: 'working' } },
  ]
  const marks = (node) => {
    if (Array.isArray(node)) return node.flatMap(marks)
    if (!node || typeof node !== 'object') return []
    return node.type?.name === 'BotMark' ? [node] : marks(node.children)
  }
  for (const [byId, shape] of [
    [{ b: { id: 'b', name: 'Fixture', role: 'Solver', avatar: { shape: 'frog' } } }, defaultShape('b')],
    [{ b: { id: 'b', name: 'Fixture', role: 'Solver', reviewerId: 'r', avatar: { shape: 'frog' } } }, 'frog'],
    [{}, defaultShape('b')],
  ]) {
    const rows = ChatRows({ items, sessionId: 'room', roster: { ...roster, byId, prefs: { layout: 'flat' } }, actions: {} })
    assert.equal(rows.length, 3)
    for (const row of rows) {
      const found = marks(row.type(row.props))
      assert.equal(found.length, 1)
      const [mark] = found
      const drawn = mark.type(mark.props)
      assert.equal(drawn.type(drawn.props).props['data-shape'], shape)
      assert.equal(mark.props.look?.shape, byId.b ? undefined : shape)
    }
  }
})

test('with the clock, a time separator sits above the first entry and after each pause of half an hour', () => {
  const items = [
    { kind: 'divider', time: 0 },
    { kind: 'user', text: 'hi', time: MINUTE },
    { kind: 'bot', text: 'one', time: 2 * MINUTE },
    { kind: 'bot', text: 'two', time: 40 * MINUTE },
    { kind: 'user', text: 'back', time: 75 * MINUTE },
  ]
  assert.deepEqual(shape(ChatRows({ items, sessionId: 'b', roster, actions: {}, clock: true })), ['PartLine', 'clock', 'EarlierUser', 'bot:one+two', 'clock', 'EarlierUser'])
})

test('a reasoning row the reader opened stays open when the turn moves it to a later step', () => {
  const first = ThinkingRow({ text: 'one', live: true, viewKey: 's:7' })
  first.props.onToggle({ currentTarget: { open: true } })
  assert.equal(ThinkingRow({ text: 'one\n\ntwo', live: true, viewKey: 's:7' }).props.open, true)
  assert.equal(ThinkingRow({ text: 'other', viewKey: 's:8' }).props.open, false)
})

test('the reasoning row is a closed details that opens to the text', () => {
  const row = ThinkingRow({ text: 'one\ntwo' })
  assert.equal(row.type, 'details')
  assert.equal(row.props.className, 'bt-think')
  assert.equal(row.props.open, false)
  assert.equal(typeof row.props.onToggle, 'function')
  const [title, box] = row.children
  assert.equal(title.type, 'summary')
  assert.equal(title.children.join(''), 'Thought it through')
  assert.equal(box.props.className, 'bt-think-text')
})

test('a live reasoning row titles "Thinking" with a ticking clock', () => {
  const row = ThinkingRow({ text: 'one\ntwo', live: true, at: Date.now() - 4000 })
  const title = row.children[0]
  assert.equal(title.children[0], 'Thinking')
  assert.equal(title.children[1]?.type?.name, 'Elapsed')
  assert.equal(title.children[1]?.props.at <= Date.now() - 4000, true)
})

test('a settled reasoning row shows the turn’s thinking time when known', () => {
  const timed = ThinkingRow({ text: 'one\ntwo', ms: 12_000 })
  const [title] = timed.children
  assert.equal(title.children[0], 'Thought it through')
  const time = title.children.find(child => child?.type === 'span')
  assert.equal(time?.children.join(''), '· 12s')
  const untimed = ThinkingRow({ text: 'one\ntwo' })
  assert.equal(untimed.children[0].children.join(''), 'Thought it through')
})

test('consecutive group messages from the same Bot chain together, and cards or user rows break the chain', () => {
  const node = (classes, botId, turn = {}) => ({
    dataset: botId ? { botId } : {},
    classList: { contains: name => classes.includes(name) },
    closest: sel => (sel === '[data-chat-group-key]' ? turn : null),
  })
  const t1 = { dataset: {} }, t2 = { dataset: {} }, t3 = { dataset: {} }, t4 = { dataset: {} }
  const m1 = node(['bt-group-msg'], 'a', t1)
  const m2 = node(['bt-group-msg'], 'a', t2)
  const card = node(['bt-q-inline'])
  const m3 = node(['bt-group-msg'], 'a', t3)
  const hostUser = node([], undefined)
  const m4 = node(['bt-group-msg'], 'a', t4)
  syncGroupChains({ querySelectorAll: () => [m1, m2, card, m3, hostUser, m4] })
  assert.equal(m1.dataset.chainPrev, undefined)
  assert.equal(m1.dataset.chainNext, '')
  assert.equal(t1.dataset.btChainNext, '')
  assert.equal(m2.dataset.chainPrev, '')
  assert.equal(m2.dataset.chainNext, undefined)
  assert.equal(t2.dataset.btChainPrev, '')
  assert.equal(m3.dataset.chainPrev, undefined)
  assert.equal(m3.dataset.chainNext, undefined)
  assert.equal(m4.dataset.chainPrev, undefined)
})
