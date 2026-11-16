// RFC 0022 delivery 1L on the window's side: the seat row in the new bar, the rendered face's
// rows, and the waiting card that shows and never answers. React is a stand-in whose elements
// are plain objects (test/left-bar-load.js's shape), so a test reads what the parts draw.
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = await build({
  stdin: {
    contents: [
      "export { teamOf, renderArt } from './src/client/left-bar.js'",
      "export * from './src/client/seat-chat.js'",
      "export { codeStore } from './src/client/code-side.js'",
      "export { QUIET, WORDED, word } from './src/client/left-bar-status.js'",
      "export { installLocale } from './src/client/i18n.js'",
    ].join('\n'),
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let stored = null
const realFetch = globalThis.fetch
globalThis.localStorage = {
  getItem: () => stored,
  setItem: (key, value) => { stored = value },
}
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useMemo: make => make(), useRef: current => ({ current }),
  useSyncExternalStore: (subscribe, snapshot) => snapshot(), Fragment: 'fragment',
  isValidElement: value => value !== null && typeof value === 'object' && 'type' in value && 'props' in value,
}
const module = { exports: {} }
new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(module, module.exports, name => (name === 'react' ? react : {}))

const {
  EMPTY_FACE, QUIET, SeatChatPanel, SeatRow, WaitingCard, WORDED, codeStore, mergeFace, renderArt, seatAgentName, seatBotId, seatChatView,
  seatClientId, seatSourceNote, seatTerminalWhy, seatWordOf, teamOf, word,
} = module.exports

/** An element with its function components drawn, down to tags and text. */
function render(element) {
  if (element === null || element === undefined || element === false) return null
  if (typeof element !== 'object') return element
  if (Array.isArray(element)) return element.map(render).filter(child => child !== null)
  if (typeof element.type === 'function') return render(element.type({ ...element.props, children: element.children }))
  return { type: element.type, props: element.props, children: element.children.map(render).filter(child => child !== null) }
}
const textOf = node => (node === null || node === undefined ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(textOf).join('') : node.children.map(textOf).join(''))
const findAll = (node, match) => (!node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(child => findAll(child, match)) : [...(match(node) ? [node] : []), ...node.children.flatMap(child => findAll(child, match))])
const buttons = node => findAll(node, entry => entry.type === 'button')
const hasClassOf = (node, name) => String(node.props?.className ?? '').split(' ').includes(name)

const seat = {
  id: 'b-aaaaaaaaaa', name: 'Orchestrator One', project: 'Project One', terminal: 't1',
  agent: 'claude', chat: 'transcript', status: 'working', order: 0,
}
/** The row the bar really opens: its key has the `seat:` prefix, its artId is the registry Bot. */
const seatRow = { ...seat, id: 'seat:b-aaaaaaaaaa', artId: 'b-aaaaaaaaaa' }

/** The Code side's tree read, answered by the test: no route of the seat's own is involved. */
const TREE = {
  projects: [{
    folder: '/project-one', name: 'Project One',
    bots: [{ id: 'b-aaaaaaaaaa', name: 'Orchestrator One', status: 'idle', terminal: { id: 't1' }, workers: [] }],
  }],
}
let fetched = []
const readCodeTree = () => {
  fetched = []
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    fetched.push(body.endpoint)
    if (body.endpoint !== 'code-tree') throw new Error(`unexpected endpoint ${body.endpoint}`)
    return { ok: true, json: async () => ({ ok: true, value: TREE }) }
  }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const part = (tree, face) => buttons(tree).find(button => button.props['data-face'] === face)
const renderSeat = onBack => render(SeatChatPanel({ onBack }))

test('the bar puts a seat under the Main Bot, marked as a seat, with its own status', () => {
  const roster = {
    bots: [{ id: 'main', name: 'Main' }, { id: 'other', name: 'Other Bot' }],
    byId: { main: { id: 'main', name: 'Main' }, other: { id: 'other', name: 'Other Bot' } },
    mainBotId: 'main', rooms: [], agents: [], roomsById: {},
  }
  const status = { bots: new Map(), dsh: new Map(), groups: new Map() }
  const team = teamOf({ roster, order: [{ kind: 'bot', item: { id: 'other', name: 'Other Bot' } }], status, seats: [seat, { ...seat, id: 'b-bbbbbbbbbb', name: 'Quiet', status: 'off', terminal: null }] })
  assert.deepEqual(team.bots.map(bot => bot.id), ['main', 'seat:b-aaaaaaaaaa', 'seat:b-bbbbbbbbbb', 'other'])
  const [won] = team.bots.filter(bot => bot.id === 'seat:b-aaaaaaaaaa')
  assert.equal(won.seat, true)
  assert.equal(won.status, 'working')
  assert.equal(won.agent, 'claude')
  assert.equal(won.terminal, 't1')
  assert.equal(won.artId, seat.id, 'the seat wears its registry Bot’s own character and colour')
  assert.deepEqual(won.channels, [])
  assert.equal(won.unread, false)
  assert.equal(team.bots.at(-1).id, 'other', 'the DSH Bots stay under the seats')
})

test('a seat row opens its face, not a DSH chat, and the waiting card shows without an answer', () => {
  const card = render(WaitingCard({ approval: { tool: 'Bash', summary: 'ls -la /srv', choices: ['allow', 'deny'], open: true }, question: null }))
  const cardText = textOf(card)
  assert.match(cardText, /Needs you/)
  assert.match(cardText, /Bash/)
  assert.match(cardText, /ls -la \/srv/)
  assert.match(cardText, /Allow once/)
  assert.match(cardText, /Deny/)
  assert.match(cardText, /never answers/)
  assert.equal(buttons(card).length, 0, 'the card has no button at all: show only')
  assert.equal(findAll(card, node => hasClassOf(node, 'bt-seat-option')).length, 2, 'the choices are plain text')
  assert.match(cardText, /Allow once · Deny/, 'the choices read as one line, not as controls')

  const question = render(WaitingCard({ approval: null, question: { kind: 'question', prompt: 'Which deploy?', options: ['staging', 'production'], answerable: false, why: 'answer-in-terminal' } }))
  assert.match(textOf(question), /Which deploy\?/)
  assert.match(textOf(question), /staging/)
  assert.equal(buttons(question).length, 0)
  assert.equal(render(WaitingCard({ approval: null, question: null })), null)
})

test('the rendered face draws text, tool calls and results; cards are never rows', () => {
  assert.match(textOf(render(SeatRow({ row: { id: 'u1', kind: 'text', role: 'user', text: 'Ship the bar' } }))), /Ship the bar/)
  const assistant = render(SeatRow({ row: { id: 'a1', kind: 'text', role: 'assistant', text: 'On it.' } }))
  assert.equal(assistant.type, 'div')
  const tool = render(SeatRow({ row: { id: 't1', kind: 'tool-call', tool: 'Bash', summary: 'npm test' } }))
  assert.match(textOf(tool), /Bash/)
  assert.match(textOf(tool), /npm test/)
  const result = render(SeatRow({ row: { id: 'r1', kind: 'tool-result', call: 't1', ok: false, output: 'boom' } }))
  assert.equal(result.type, 'details')
  assert.match(textOf(result), /Error output/)
  assert.match(textOf(result), /boom/)
  assert.equal(render(SeatRow({ row: { id: 'q1', kind: 'question', prompt: 'Which?' } })), null)
  assert.equal(render(SeatRow({ row: { id: 'x1', kind: 'tokens', input: 1, output: 2, cache: 0 } })), null)
})

test('a read of another seat replaces the face: one seat never shows another seat’s rows', () => {
  const one = { ...EMPTY_FACE, terminal: 't1', rows: [{ id: 'a' }, { id: 'b' }], status: { state: 'working' } }
  const same = mergeFace(one, { rows: [{ id: 'c' }], status: { state: 'working' } }, 't1')
  assert.deepEqual(same.rows.map(row => row.id), ['a', 'b', 'c'], 'the same seat appends')
  assert.deepEqual(mergeFace(same, { rows: [{ id: 'c' }, { id: 'd' }], reset: true }, 't1').rows.map(row => row.id), ['c', 'd'], 'a reset replaces')
  const other = mergeFace(same, { rows: [{ id: 'x' }], status: { state: 'blocked' }, approval: { tool: 'Bash' } }, 't2')
  assert.equal(other.terminal, 't2')
  assert.deepEqual(other.rows.map(row => row.id), ['x'], 'another seat starts clean')
  assert.deepEqual(other.approval, { tool: 'Bash' })
  assert.equal(mergeFace(one, { rows: [] }, 't1').rows.length, 2)
})

test('one mark set: idle draws no mark, and a seat that is not running says so in words', () => {
  assert.equal(QUIET.includes('idle'), true, 'idle is silent for a Bot and for a seat')
  assert.equal(WORDED.includes('off'), true, 'not running says its word, never a bare hollow ring')
  assert.equal(word('off'), 'Not running')
  // The seat art is the registry Bot's character; the pane glyph is only the no-Bot fallback.
  const art = renderArt({ seat: true, artId: 'b-novaaaaaaa', name: 'Nova' }, 28, 'working')
  assert.equal(art.props.bot.id, 'b-novaaaaaaa', 'the look hashes the registry id, never the row key')
  assert.equal(renderArt({ seat: true }, 28, 'idle').type?.name, 'SeatGlyph')
})

test('the panel says where the rows come from and what it never does', () => {
  assert.equal(seatWordOf({ state: 'blocked' }), 'needs')
  assert.equal(seatWordOf({ state: 'error' }), 'error')
  assert.equal(seatWordOf({ state: 'working' }), 'working')
  assert.equal(seatWordOf({ state: 'done' }), 'idle')
  assert.equal(seatWordOf(null), 'off')
  assert.equal(seatAgentName('claude'), 'Claude Code')
  assert.equal(seatAgentName('codex'), 'Codex')
  assert.match(seatSourceNote({ chat: 'screen' }), /Screen only/)
  assert.match(seatSourceNote({ chat: 'transcript' }), /never runs or types/)
  const empty = render(SeatChatPanel({ onBack: () => {} }))
  assert.match(textOf(empty), /Choose a seat/)
  // The header says its status word, working included: a lone dot is not enough.
  seatChatView.set({ seat: { ...seat, status: 'working' } })
  try {
    const open = render(SeatChatPanel({ onBack: () => {} }))
    assert.match(textOf(open), /Orchestrator One/)
    assert.match(textOf(open), /Working/)
    assert.match(textOf(open), /This computer/)
  } finally {
    seatChatView.set({ seat: null })
  }
})

test('the window keeps one seat-chat id across reloads and never trusts a bad one', () => {
  stored = null
  const first = seatClientId()
  assert.match(first, /^w-[A-Za-z0-9._:-]{1,64}$/)
  assert.equal(seatClientId(), first, 'a reload keeps the same watch')
  stored = 'bad id with spaces'
  const second = seatClientId()
  assert.notEqual(second, 'bad id with spaces')
  stored = null
})

test('the panel is its own keyed main panel, not a Session', () => {
  assert.equal(module.exports.SEAT_CHAT_PANEL, 'seat-chat')
  seatChatView.set({ seat: null })
  assert.deepEqual(seatChatView.getSnapshot(), { seat: null }, 'the store names no seat before the bar opens one')
})

test('a seat row keys the Code side by its registry Bot, never by its seat: row key', () => {
  assert.equal(seatBotId(seatRow), 'b-aaaaaaaaaa')
  assert.equal(seatBotId({ ...seatRow, artId: undefined }), 'b-aaaaaaaaaa', 'the seat: prefix is not a Bot id')
  assert.equal(seatBotId(seat), 'b-aaaaaaaaaa')
  assert.equal(seatBotId({ ...seatRow, artId: undefined, id: 'seat:' }), null)
  assert.equal(seatBotId(null), null)
  assert.equal(seatTerminalWhy(seatRow), null)
  assert.match(seatTerminalWhy({ ...seatRow, terminal: null }), /not running on this computer/)
  assert.equal(seatTerminalWhy(null), null)
})

test('the switch appears for a seat row that names its registry Bot', () => {
  seatChatView.set({ seat: { ...seatRow, artId: undefined, id: 'seat:' } })
  try {
    assert.equal(part(renderSeat(() => {}), 'terminal'), undefined, 'no registry Bot behind the row: no switch')
  } finally {
    seatChatView.set({ seat: null })
  }
})

test('a live seat shows the switch; Terminal opens that registry Bot pane; Chat and Back return', async (t) => {
  readCodeTree()
  t.after(() => {
    globalThis.fetch = realFetch
    codeStore.reset()
    seatChatView.set({ seat: null })
  })
  let backs = 0
  const onBack = () => { backs += 1 }
  seatChatView.set({ seat: seatRow })
  let tree = renderSeat(onBack)
  assert.equal(part(tree, 'chat').props['aria-pressed'], true)
  assert.equal(part(tree, 'terminal').props['aria-pressed'], false)
  assert.equal(part(tree, 'terminal').props['aria-disabled'], undefined, 'the live pane opens')
  part(tree, 'terminal').props.onClick()
  await settle()
  assert.equal(codeStore.snapshot().face, 'terminal')
  assert.equal(codeStore.snapshot().botId, 'b-aaaaaaaaaa', 'the registry Bot id, not seat:b-aaaaaaaaaa')
  assert.equal(codeStore.snapshot().seat, true, 'the seat panel draws the Code body itself')
  assert.deepEqual(codeStore.snapshot().selected, { botId: 'b-aaaaaaaaaa', worker: null })
  assert.deepEqual(fetched, ['code-tree'], 'Terminal reads the Code side tree: it adds no route of its own')

  tree = renderSeat(onBack)
  assert.equal(tree.props['data-seat-face'], 'terminal')
  assert.equal(part(tree, 'terminal').props['aria-pressed'], true)
  part(tree, 'chat').props.onClick()
  assert.equal(codeStore.snapshot().face, 'chat', 'the Chat part returns to the seat face')
  assert.equal(renderSeat(onBack).props['data-seat-face'], 'chat')

  // Terminal again: Back returns to the seat face and does not leave the panel.
  part(renderSeat(onBack), 'terminal').props.onClick()
  await settle()
  const back = buttons(renderSeat(onBack)).find(button => button.props.className === 'bt-seat-back')
  assert.equal(back.props['aria-label'], 'Back to chat')
  back.props.onClick()
  assert.equal(codeStore.snapshot().face, 'chat')
  assert.equal(backs, 0, 'Back stays on the seat while Terminal is open')
  buttons(renderSeat(onBack)).find(button => button.props.className === 'bt-seat-back').props.onClick()
  assert.equal(backs, 1, 'in Chat, Back leaves the seat')
})

test('a seat with no live pane keeps Terminal, says why, and opens nothing', (t) => {
  readCodeTree()
  t.after(() => {
    globalThis.fetch = realFetch
    codeStore.reset()
    seatChatView.set({ seat: null })
  })
  seatChatView.set({ seat: { ...seatRow, terminal: null, status: 'off', chat: null } })
  const tree = renderSeat(() => { throw new Error('a quiet seat must not leave from the switch') })
  const terminal = part(tree, 'terminal')
  assert.ok(terminal, 'Terminal stays on screen')
  assert.equal(terminal.props['aria-disabled'], 'true')
  assert.equal(terminal.props.onClick, undefined, 'a press opens nothing')
  assert.match(String(terminal.props.title), /not running on this computer/)
  assert.match(textOf(tree), /not running on this computer/, 'the reason is on screen in plain words')
  assert.equal(part(tree, 'chat').props['aria-pressed'], true)
  assert.equal(codeStore.snapshot().face, 'chat')
  assert.deepEqual(fetched, [], 'no tree, no chunk and no new route is fetched')
})
