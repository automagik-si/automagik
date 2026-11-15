import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/cells.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
function MarkdownText() { return null }
const effects = []
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, AbortController, fetch,
  require: (name) => {
    const platform = {
      react: { createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx }, useContext: ctx => ctx.value, useCallback: fn => fn, useId: () => 'dv-id', useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(), 
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [initial, () => {}], useEffect: (run) => { effects.push(run) }, useRef: current => ({ current }),
        useLayoutEffect: () => {}, useMemo: make => make(), Fragment: 'fragment',
      },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { AssistantCell, TriggerCell, TurnTailCell, ThinkingRow, CellEmpty } = module.exports

// Renders the named components of an element tree, leaving the rest as elements.
const expand = (node, names) => {
  if (Array.isArray(node)) return node.flatMap(child => expand(child, names))
  if (node === null || typeof node !== 'object') return node
  if (names.includes(node.type?.name)) return expand(node.type({ ...node.props, children: node.children }), names)
  return { ...node, children: node.children.map(child => expand(child, names)) }
}
const find = (node, match) => {
  if (Array.isArray(node)) return node.flatMap(child => find(child, match))
  if (node === null || typeof node !== 'object') return []
  return [...(match(node) ? [node] : []), ...find(node.children, match)]
}
const textOf = (node) => {
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || typeof node !== 'object') return String(node ?? '')
  return textOf(node.children ?? [])
}

const roster = { bots: [], byId: { b: { id: 'b', name: 'Writer' } }, roomsById: {}, exchangeTurns: {} }
const finished = { turn: 3, status: 'closed', end: { time: 2_000 } }
function cellProps({ closingSeq = 10, turn = finished } = {}) {
  const asked = []
  const links = { resolve: () => undefined }
  const props = {
    node: {
      key: 'n10',
      location: { kind: 'step', turn },
      data: { turn: 3, step: 1, seq: 10, status: 'done', finalNode: { seq: 10 }, blocks: [{ kind: 'text', text: 'The brief is in `/work/brief.md`.' }] },
    },
    sessionId: 'b',
    openFile: () => {},
    fileMentions: (owner) => { asked.push(owner); return links },
    useTurnData: key => (key === 'turn-tail' ? { closing: { finalNode: { seq: closingSeq } } } : undefined),
    useRoster: select => select(roster),
    useUi: () => null,
    useTurnSteps: () => [],
    useTurnContext: () => [],
    actions: { noteLive() {} },
  }
  return { props, asked, links }
}
const markdownOf = props => find(expand(AssistantCell(props), ['Bubbles', 'Bubble']), node => node.type === MarkdownText)

test('a reply that closes its turn links the files the turn changed or delivered', () => {
  const { props, asked, links } = cellProps()
  const [markdown] = markdownOf(props)
  assert.equal(markdown.props.fileMentions, links)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].turn, finished)
  assert.equal(asked[0].seq, 10)
  assert.equal(asked[0].openFile, props.openFile)
})

test('a reply that does not close its turn, or one still running, links nothing', () => {
  const earlier = cellProps({ closingSeq: 12 })
  assert.equal(markdownOf(earlier.props)[0].props.fileMentions, undefined)
  const running = cellProps({ turn: { turn: 3, status: 'open' } })
  assert.equal(markdownOf(running.props)[0].props.fileMentions, undefined)
  assert.equal(earlier.asked.length + running.asked.length, 0)
})

test('the turn tail entry notes when the turn ended and shows the pause before the next one', () => {
  effects.length = 0
  const noted = []
  const clock = { b: { 3: { first: 1_000, end: 2_000 }, 4: { first: 2_000 + 60 * 60 * 1000 } } }
  const out = TurnTailCell({
    turn: finished,
    sessionId: 'b',
    useRoster: select => select(roster),
    useTurnClock: select => select(clock),
    useUi: () => undefined,
    actions: { noteTurnTime: (...args) => noted.push(args) },
  })
  for (const run of effects) run()
  assert.deepEqual(noted, [['b', 3, 'end', 2_000]])
  assert.equal(find(out, node => node.props?.className === 'bt-time-sep').length, 1)
  assert.equal(find(out, node => node.props?.className === 'bt-turn-time').length, 1)
})

// #161: a Bot-to-Bot exchange turn hides its reply under the "N messages with" line, so a
// reply time under it stood alone, and a run of them read as a history of blank messages.
test('a hidden exchange turn shows no reply time, and still notes when it ended', () => {
  effects.length = 0
  const noted = []
  const clock = { b: { 3: { first: 1_000, end: 2_000 }, 4: { first: 2_000 + 60 * 1000 } } }
  const out = TurnTailCell({
    turn: finished,
    sessionId: 'b',
    useRoster: select => select({ ...roster, exchangeTurns: { b: [3] } }),
    useTurnClock: select => select(clock),
    useUi: () => undefined,
    actions: { noteTurnTime: (...args) => noted.push(args) },
  })
  for (const run of effects) run()
  assert.deepEqual(noted, [['b', 3, 'end', 2_000]])
  assert.equal(find(out, node => node.props?.className === 'bt-turn-time').length, 0)
})

test('no pause separator stands before a hidden turn that folds into the one before it', () => {
  const clock = { b: { 3: { first: 1_000, end: 2_000 }, 4: { first: 2_000 + 60 * 60 * 1000 } } }
  const tail = exchangeTurns => TurnTailCell({
    turn: finished,
    sessionId: 'b',
    useRoster: select => select({ ...roster, exchangeTurns: { b: exchangeTurns } }),
    useTurnClock: select => select(clock),
    useUi: () => undefined,
    actions: { noteTurnTime() {} },
  })
  const separators = out => find(out, node => node.props?.className === 'bt-time-sep').length
  assert.equal(separators(tail([3, 4])), 0)
  // A hidden turn after a shown one opens its own line, so the pause before it shows.
  assert.equal(separators(tail([4])), 1)
  assert.equal(separators(tail([3])), 1)
})

// A run of hidden turns is one fold, so nothing may split it: no reply time, no pause,
// and no unread divider before a turn the fold already covers.
const tailOf = ({
  turn = finished, hidden = [], clock, visit, actions = { noteTurnTime() {} },
}) => TurnTailCell({
  turn,
  sessionId: 'b',
  useRoster: select => select({ ...roster, exchangeTurns: { b: hidden } }),
  useTurnClock: select => select(clock),
  useUi: select => select(visit ? { visits: { b: visit } } : {}),
  actions,
})
const countOf = (node, className) => find(
  expand(node, ['NewDivider']), entry => entry.props?.className === className,
).length

test('a run of hidden turns draws no time, pause, or unread divider between them', () => {
  const end = 2_000
  const clock = { b: {
    3: { first: 1_000, end },
    4: { first: end + 2 * 60 * 60 * 1000 },
    5: { first: end + 4 * 60 * 60 * 1000 },
  } }
  // Turn 4 began after the visit, but it folds into turn 3's line, so no "New" stands
  // between them.
  const out = tailOf({
    hidden: [3, 4, 5], clock, visit: { seen: end + 1_000, entered: end + 5 * 60 * 60 * 1000 },
  })
  assert.equal(countOf(out, 'bt-turn-time'), 0)
  assert.equal(countOf(out, 'bt-time-sep'), 0)
  assert.equal(countOf(out, 'bt-new-sep'), 0)
})

test("a hidden turn in another Bot's chat leaves this chat's times and pauses alone", () => {
  const clock = { b: { 3: { first: 1_000, end: 2_000 }, 4: { first: 2_000 + 60 * 60 * 1000 } } }
  const out = TurnTailCell({
    turn: finished,
    sessionId: 'b',
    useRoster: select => select({ ...roster, exchangeTurns: { a: [3, 4] } }),
    useTurnClock: select => select(clock),
    useUi: () => undefined,
    actions: { noteTurnTime() {} },
  })
  assert.equal(countOf(out, 'bt-turn-time'), 1)
  assert.equal(countOf(out, 'bt-time-sep'), 1)
})

test('a hidden turn with no turn after it draws nothing, and still notes when it ended', () => {
  effects.length = 0
  const noted = []
  const out = tailOf({
    hidden: [3],
    clock: { b: { 3: { first: 1_000, end: 2_000 } } },
    actions: { noteTurnTime: (...args) => noted.push(args) },
  })
  for (const run of effects) run()
  assert.equal(countOf(out, 'bt-turn-time'), 0)
  assert.equal(countOf(out, 'bt-time-sep'), 0)
  assert.deepEqual(noted, [['b', 3, 'end', 2_000]])
})

test('the first visible turn after a hidden run keeps its time and the pauses around it', () => {
  const end = 2_000
  const hiddenNext = end + 60 * 60 * 1000
  const visible = end + 3 * 60 * 60 * 1000
  const visibleNext = visible + 2 * 60 * 60 * 1000
  const clock = { b: {
    3: { first: 1_000, end },
    4: { first: hiddenNext },
    5: { first: visible },
    6: { first: visibleNext },
  } }
  const location = (turn, time) => ({ turn, status: 'closed', end: { time } })
  const first = tailOf({ turn: location(3, end), hidden: [3, 4], clock })
  assert.equal(countOf(first, 'bt-time-sep'), 0, 'the hidden run folds; nothing splits it')
  const lastHidden = tailOf({ turn: location(4, hiddenNext), hidden: [3, 4], clock })
  assert.equal(countOf(lastHidden, 'bt-turn-time'), 0, 'the hidden turn still shows no time')
  const [separator] = find(lastHidden, node => node.props?.className === 'bt-time-sep')
  assert.ok(separator, 'the pause before the visible turn still shows')
  const stamp = time => new Date(time)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const start = stamp(visible)
  const before = stamp(hiddenNext)
  const label = textOf(separator)
  assert.ok(label.includes(start), `the separator names the visible turn's start, got ${label}`)
  assert.ok(!label.includes(before), `the separator must not name the hidden turn, got ${label}`)
  const shown = tailOf({ turn: location(5, visible), hidden: [3, 4], clock })
  assert.equal(countOf(shown, 'bt-turn-time'), 1, 'the visible turn keeps its reply time')
  assert.equal(countOf(shown, 'bt-time-sep'), 1, 'and the pause before the turn after it')
})

test('the unread divider still opens a hidden run, above its fold line', () => {
  const end = 2_000
  const clock = { b: {
    2: { first: 500, end },
    3: { first: end + 60 * 60 * 1000 },
    4: { first: end + 2 * 60 * 60 * 1000 },
  } }
  const out = tailOf({
    turn: { turn: 2, status: 'closed', end: { time: end } },
    hidden: [3, 4],
    clock,
    visit: { seen: end + 1_000, entered: end + 3 * 60 * 60 * 1000 },
  })
  assert.equal(countOf(out, 'bt-new-sep'), 1)
})

test('the unread divider still stands before the visible turn that ends a hidden run', () => {
  const end = 2_000
  const hiddenNext = end + 60 * 60 * 1000
  const visible = end + 3 * 60 * 60 * 1000
  const clock = { b: {
    3: { first: 1_000, end },
    4: { first: hiddenNext },
    5: { first: visible },
  } }
  const out = tailOf({
    turn: { turn: 4, status: 'closed', end: { time: hiddenNext } },
    hidden: [3, 4],
    clock,
    visit: { seen: hiddenNext + 1_000, entered: visible + 1_000 },
  })
  assert.equal(countOf(out, 'bt-new-sep'), 1)
  assert.equal(countOf(out, 'bt-time-sep'), 1)
})

// The fold is still what the hidden turns show; only the tail rows go.
test('a run of hidden turns still shows its "N messages with" line', () => {
  const team = {
    ...roster,
    byId: { ...roster.byId, a: { id: 'a', name: 'Automagik', color: 'gray' } },
    exchangeTurns: { b: [3, 4] },
  }
  const node = {
    key: 'turn-trigger:11', kind: 'turn-trigger', location: { turn: { turn: 3 } },
    data: {
      seq: 11, content: [],
      source: { kind: 'bot', role: 'request', senderSessionId: 'a', senderName: 'Automagik' },
    },
  }
  const out = expand(TriggerCell({
    node, sessionId: 'b', actions: {},
    useRoster: select => select(team),
    useSessions: select => select({
      byId: { b: { projectionValues: { turnOutline: [{ turn: 3 }, { turn: 4 }] } } },
    }),
    useTurnClock: select => select({
      b: { 3: { first: 1_000, peer: 'a' }, 4: { first: 2_000, peer: 'a' } },
    }),
    useUi: select => select({ visits: {} }),
  }), ['EventLine'])
  const [line] = find(out, entry => entry.props?.className === 'bt-event-whole')
  assert.ok(line, 'the hidden turns keep their fold line')
  assert.match(textOf(line), /4 messages with/)
  assert.match(textOf(line), /Automagik/)
})

// #206: the user reads a Bot's reply in its own chat, so it folds only where rendering
// all of it would slow the chat down.
test('a Bot reply in its own chat stays whole up to 20,000 characters', () => {
  const reply = text => {
    const { props } = cellProps()
    props.node.data.blocks = [{ kind: 'text', text }]
    return markdownOf(props)[0].props.text
  }
  const long = Array.from({ length: 60 }, (_, index) => `Line ${index + 1} of a long answer.`).join('\n')
  assert.equal(reply(long), long)
  assert.equal(reply('w'.repeat(25_000)), 'w'.repeat(600))
})

// #465: the thinking row stays a switchable extra, and the one activity row is
// never given up to it.
test('the thinking row shows only with its switch on, and the activity row is never yielded to it', () => {
  const cell = (prefs, blocks, steps) => {
    effects.length = 0
    const noted = []
    const { props } = cellProps()
    props.node.data = { turn: 3, step: 1, seq: 10, status: 'running', finalNode: { seq: 10 }, blocks }
    props.useTurnSteps = () => steps
    props.actions = { noteLive: (sessionId, id) => noted.push(id) }
    const useRoster = select => select({ ...roster, prefs })
    const out = expand(AssistantCell({ ...props, useRoster }), [])
    for (const run of effects) run()
    return { out, noted }
  }
  const reason = [{ kind: 'reasoning', text: 'Weighing it' }]
  const thinking = { turn: 3, step: 1, status: 'running', blocks: reason }
  // Off: a thinking step draws nothing (the empty mark) and notes nothing.
  const off = cell({}, reason, [thinking])
  assert.equal(off.out?.type, CellEmpty)
  assert.deepEqual(off.noted, [])
  // On: the live row shows — and still notes nothing, so the activity row stays.
  const on = cell({ thinking: true }, reason, [thinking])
  assert.equal(find(on.out, node => node.type === ThinkingRow).length, 1)
  assert.equal(on.noted.filter(id => id.startsWith('think:')).length, 0)
  assert.deepEqual(on.noted, [])
  // A reply streaming in does give the activity row its one note, on or off.
  const replying = { turn: 3, step: 1, status: 'running', blocks: [{ kind: 'reasoning', text: 'Weighing it' }, { kind: 'text', text: 'Done' }] }
  for (const prefs of [{}, { thinking: true }]) {
    const { noted } = cell(prefs, replying.blocks, [replying])
    assert.ok(noted.every(id => id.startsWith('text:')))
  }
})
