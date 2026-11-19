// #1326 K2: the mounted backfill card. A proposal shows the chats and dates it would read,
// the person ticks and sets them, and one Start sends the single approval. Live `omniBackfills`
// rows move beside it, and only a row that can still stop offers Stop. The harness keeps hook
// state across renders (as test/genui-person-card.test.js does), so it drives the real card.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { BackfillCard } from './src/client/genui.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
})
let current
const slot = (make) => {
  const index = current.index++
  return current.slots[index] ??= make()
}
const effect = (make, deps) => {
  const cell = slot(() => ({}))
  if (!cell.deps || deps.some((value, index) => value !== cell.deps[index])) {
    current.effects.push(() => { cell.stop?.(); cell.stop = make(); cell.deps = deps })
  }
}
const react = {
  Fragment: 'fragment',
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useCallback: fn => fn,
  useMemo: make => make(),
  useRef: initial => slot(() => ({ current: initial })),
  useState: (initial) => {
    const cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [cell.value, next => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
  },
  useEffect: effect,
  useLayoutEffect: effect,
  useId: () => slot(() => ({ id: 'backfill-card-id' })).id,
  createContext: initial => ({ value: initial, _currentValue: initial, Provider: () => null }),
  useContext: ctx => ctx.value,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module,
  exports: module.exports,
  require: name => (name === 'react' ? react : { MarkdownText: ({ text }) => text }),
  URL,
  setTimeout,
  clearTimeout,
  console,
  TextEncoder,
  TextDecoder,
  fetch: async () => { throw new Error('the card was given its own start and cancel') },
})
const { BackfillCard } = module.exports

const mount = (Component, props) => {
  const instance = {
    slots: [], effects: [], props,
    render(next = instance.props) {
      instance.props = next
      instance.index = 0
      current = instance
      const out = Component(next)
      current = undefined
      for (const run of instance.effects.splice(0)) run()
      return out
    },
    unmount() { for (const cell of instance.slots) cell.stop?.() },
  }
  return instance
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
// Every word the card draws, wherever it sits in the tree.
const flat = (node) => {
  if (Array.isArray(node)) return node.flatMap(flat)
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'object') {
    if (typeof node.type === 'function') return flat(node.type(node.props))
    return flat(node.props?.children)
  }
  return [String(node)]
}
const textOf = node => flat(node).join('\n')
// Every element in the tree, props included (a row's action button is a prop).
const elements = (node, out = []) => {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  if (node.type !== undefined) out.push(node)
  for (const [key, value] of Object.entries(node.props ?? {})) {
    if (key !== 'children') elements(value, out)
  }
  if (Array.isArray(node.props?.children)) elements(node.props.children, out)
  else if (node.props?.children !== undefined) elements(node.props.children, out)
  return out
}
const byClass = (node, name) => elements(node).filter(item => String(item.props?.className ?? '').split(/\s+/).includes(name))
const byType = (node, type) => elements(node).filter(item => item.type === type)
const buttonOf = (node, name) => byClass(node, name)[0]

const FROM = '2026-03-01T00:00:00.000Z'
const TO = '2026-11-15T23:59:59.999Z'
const PROPOSAL = {
  id: 'p1', botId: 'm1', from: FROM, to: TO, createdAt: 1,
  chats: [
    { id: 'c1', name: 'Ana', kind: 'dm', channelId: 'inst-1', channel: 'Shop line', ticked: true },
    { id: 'c2', name: 'Bruno', kind: 'dm', channelId: 'inst-1', channel: 'Shop line', ticked: false },
  ],
}
const ROW = (chatId, chat, jobId, state, outcome, counts = {}) => ({ chatId, chat, channelId: 'inst-1', jobId, state, outcome, counts })
const RUN = (rows) => ({
  id: 'p1', botId: 'm1', from: FROM, to: TO, startedAt: 1_795_003_201_000,
  summary: { total: rows.length, running: rows.filter(row => row.outcome === null).length, done: rows.filter(row => row.outcome === 'done').length, phoneDidNotAnswer: 0, stopped: rows.filter(row => row.outcome === 'stopped').length, failed: rows.filter(row => row.outcome === 'failed').length },
  rows,
})

test('one Start sends the selected chats and both dates once, and says the approval is going out', async () => {
  const answer = deferred()
  const calls = []
  const start = payload => { calls.push(payload); return answer.promise }
  const card = mount(BackfillCard, { roster: { omniBackfillProposals: [PROPOSAL], omniBackfills: [] }, start, cancel: async () => assert.fail('no cancel here') })
  let tree = card.render()
  let text = textOf(tree)
  assert.match(text, /Read chat history/)
  assert.match(text, /Mar 1, 2026 – Nov 15, 2026/)
  assert.match(text, /Ana/)
  assert.match(text, /Bruno/)
  assert.match(text, /Choose the chats to read/)
  // Ana came ticked from the proposal: the person can press Start without changing anything.
  const startButton = buttonOf(tree, 'bt-genui-start')
  assert.equal(startButton.props.disabled, false)
  const sent = startButton.props.onClick()
  tree = card.render()
  text = textOf(tree)
  assert.match(text, /Starting…/)
  assert.match(text, /Sending your approval…/)
  assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { proposalId: 'p1', chats: ['c1'], from: '2026-03-01', to: '2026-11-15' })
  // The host takes the proposal and queues one job per ticked chat.
  answer.resolve({ runId: 'p1', jobs: [{ chatId: 'c1', jobId: 'j1', state: 'queued' }] })
  await sent
  await tick()
  text = textOf(card.render())
  assert.match(text, /Your approval was sent\. One backfill is starting for each chat you chose\./)
  assert.equal(calls.length, 1, 'a single approval, never one request per chat')
  card.unmount()
})

test('nothing is sent until a chat and both dates are chosen, and a backwards range says so', async () => {
  const calls = []
  const start = payload => { calls.push(payload); return Promise.resolve({ runId: 'p1', jobs: [] }) }
  const proposal = { id: 'p2', chats: [{ id: 'c1', name: 'Ana', channel: 'Shop line', ticked: false }] }
  const card = mount(BackfillCard, { roster: { omniBackfillProposals: [proposal], omniBackfills: [] }, start, cancel: async () => {} })
  let tree = card.render()
  assert.equal(buttonOf(tree, 'bt-genui-start').props.disabled, true)
  // Pressing a disabled Start anyway sends nothing.
  await buttonOf(tree, 'bt-genui-start').props.onClick()
  assert.equal(calls.length, 0)
  // Tick Ana; the dates are still missing.
  const check = byType(tree, 'input').find(input => input.props.type === 'checkbox')
  check.props.onChange()
  tree = card.render()
  assert.equal(buttonOf(tree, 'bt-genui-start').props.disabled, true)
  // Both dates set: one Start, one request, the person's chats and dates.
  const dates = byType(tree, 'input').filter(input => input.props.type === 'date')
  dates.find(input => input.props['aria-label'] === 'Start date').props.onChange({ target: { value: '2026-03-01' } })
  dates.find(input => input.props['aria-label'] === 'End date').props.onChange({ target: { value: '2026-11-15' } })
  tree = card.render()
  assert.equal(buttonOf(tree, 'bt-genui-start').props.disabled, false)
  await buttonOf(tree, 'bt-genui-start').props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ proposalId: 'p2', chats: ['c1'], from: '2026-03-01', to: '2026-11-15' }])
  // A range that starts after it ends is refused before it is sent, and says why.
  const calls2 = []
  const card2 = mount(BackfillCard, { roster: { omniBackfillProposals: [proposal], omniBackfills: [] }, start: payload => { calls2.push(payload); return Promise.resolve({ runId: 'p2', jobs: [] }) }, cancel: async () => {} })
  let other = card2.render()
  const later = byType(other, 'input').filter(input => input.props.type === 'date')
  later.find(input => input.props['aria-label'] === 'Start date').props.onChange({ target: { value: '2026-11-15' } })
  later.find(input => input.props['aria-label'] === 'End date').props.onChange({ target: { value: '2026-03-01' } })
  other = card2.render()
  assert.equal(buttonOf(other, 'bt-genui-start').props.disabled, true)
  assert.match(textOf(other), /The start date must be before the end date\./)
  await buttonOf(other, 'bt-genui-start').props.onClick()
  assert.equal(calls2.length, 0)
  card.unmount()
  card2.unmount()
})

test('a refused approval says why, and the card keeps the proposal for another try', async () => {
  const calls = []
  const start = payload => { calls.push(payload); return Promise.reject(new Error('This proposal is no longer open: ask the Bot again.')) }
  const card = mount(BackfillCard, { roster: { omniBackfillProposals: [PROPOSAL], omniBackfills: [] }, start, cancel: async () => {} })
  const sent = buttonOf(card.render(), 'bt-genui-start').props.onClick()
  await sent
  await tick()
  const text = textOf(card.render())
  assert.match(text, /This proposal is no longer open: ask the Bot again\./)
  assert.equal(buttonOf(card.render(), 'bt-genui-start').props.disabled, false, 'the person can try again')
  assert.equal(calls.length, 1)
  card.unmount()
})

test('live runs draw their rows and only a running row offers Stop, once', async () => {
  const answer = deferred()
  const calls = []
  const cancel = payload => { calls.push(payload); return answer.promise }
  const runs = [RUN([
    ROW('c1', 'Ana', 'j1', 'fetching', null, { fetched: 50, stored: 40, duplicates: 10, mediaDownloaded: 5, mediaMissing: 1, reactions: 2, edits: 1, deletions: 1, unmatched: 0 }),
    ROW('c2', 'Bruno', 'j2', 'done', 'done', { fetched: 80, stored: 80 }),
  ])]
  const card = mount(BackfillCard, { roster: { omniBackfillProposals: [], omniBackfills: runs }, start: async () => {}, cancel })
  let tree = card.render()
  let text = textOf(tree)
  assert.match(text, /Backfills/)
  assert.match(text, /1 running · 1 done/)
  assert.match(text, /50 fetched/)
  assert.match(text, /Ana/)
  assert.match(text, /Bruno/)
  const stops = byClass(tree, 'bt-genui-cancel')
  assert.equal(stops.length, 1, 'the done row cannot be stopped')
  assert.match(String(stops[0].props['aria-label']), /Stop the backfill of Ana/)
  const stopping = stops[0].props.onClick()
  tree = card.render()
  assert.match(textOf(tree), /Stopping…/)
  // A second press while the cancel is out does nothing.
  const again = byClass(tree, 'bt-genui-cancel')[0]
  assert.equal(again.props.disabled, true)
  await again.props.onClick()
  assert.equal(calls.length, 1)
  // The endpoint stops the job; the row ends on the next live answer.
  answer.resolve({ jobId: 'j1', state: 'cancelled', outcome: 'stopped' })
  await stopping
  await tick()
  const ended = [{ ...runs[0], rows: [ROW('c1', 'Ana', 'j1', 'cancelled', 'stopped'), ROW('c2', 'Bruno', 'j2', 'done', 'done')], summary: { total: 2, running: 0, done: 1, phoneDidNotAnswer: 0, stopped: 1, failed: 0 } }]
  tree = card.render({ roster: { omniBackfillProposals: [], omniBackfills: ended }, start: async () => {}, cancel })
  assert.equal(byClass(tree, 'bt-genui-cancel').length, 0)
  assert.match(textOf(tree), /Stopped/)
  card.unmount()
})

test('the range and both date inputs say the same UTC day, including a single-day range', () => {
  // One proposal at each edge of the range: a western viewer would read the first day as
  // Feb 28 and an eastern viewer the last as Nov 16, while the inputs say Mar 1 and Nov 15.
  const firstDay = { ...PROPOSAL, id: 'p3', from: FROM, to: FROM }
  const lastDay = { ...PROPOSAL, id: 'p4', from: TO, to: TO }
  const card = mount(BackfillCard, {
    roster: { omniBackfillProposals: [firstDay, lastDay], omniBackfills: [] },
    start: async () => {}, cancel: async () => {},
  })
  const tree = card.render()
  const dates = byType(tree, 'input').filter(input => input.props.type === 'date')
  assert.deepEqual(dates.map(input => input.props.value), ['2026-03-01', '2026-03-01', '2026-11-15', '2026-11-15'])
  const text = textOf(tree)
  assert.match(text, /Mar 1, 2026/)
  assert.match(text, /Nov 15, 2026/)
  assert.doesNotMatch(text, /Feb 28, 2026|Nov 16, 2026/)
  card.unmount()
  // A live run with the same single day says that day once, not the viewer's next one.
  const run = { id: 'r1', botId: 'm1', from: TO, to: TO, startedAt: 1_795_003_201_000, rows: [] }
  const runCard = mount(BackfillCard, {
    roster: { omniBackfillProposals: [], omniBackfills: [run] }, start: async () => {}, cancel: async () => {},
  })
  const runText = textOf(runCard.render())
  assert.match(runText, /Nov 15, 2026/)
  assert.doesNotMatch(runText, /Nov 16, 2026/)
  runCard.unmount()
})

test('a cancel that fails says why, and an empty roster draws nothing', async () => {
  const card = mount(BackfillCard, { roster: {}, start: async () => {}, cancel: async () => {} })
  assert.equal(card.render(), null)
  const cancel = async () => { throw new Error('No backfill job here: backfill_status lists them.') }
  const runs = [RUN([ROW('c1', 'Ana', 'j1', 'fetching', null)])]
  const cardWithRun = mount(BackfillCard, { roster: { omniBackfillProposals: [], omniBackfills: runs }, start: async () => {}, cancel })
  await byClass(cardWithRun.render(), 'bt-genui-cancel')[0].props.onClick()
  await tick()
  assert.match(textOf(cardWithRun.render()), /No backfill job here: backfill_status lists them\./)
  card.unmount()
  cardWithRun.unmount()
})
