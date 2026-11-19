// #1326 K1: the shared kit's read-only rule, from the built client bundle a plugin loads.
// The person card reads `omni-reading-note` and nothing else; a card with no chat id asks
// nothing at all. No write endpoint is named here: the card never saves a note.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { guardBackfillFields } from '../src/host/genui.js'

const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// DSH's client loader hands the bundle a factory and a `require` with the shell's own
// modules; the test gives it the same three, as test/client-bundle.test.js does.
const react = {
  Component: class {}, createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useState: initial => [initial, () => {}], useEffect: () => {}, useMemo: make => make(),
  useCallback: fn => fn, useRef: current => ({ current }), useId: () => 'id',
  useSyncExternalStore: (sub, get) => get(),
  createContext: initial => ({ value: initial, _currentValue: initial, Provider: () => null }),
  useContext: ctx => ctx.value,
}
const platform = {
  react,
  'react-dom': { createPortal: node => node },
  '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null },
}

function load({ fetch }) {
  const registrations = []
  const sandbox = {
    window: { __ModuleLoader__: { load: registration => registrations.push(registration) } },
    fetch,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { language: 'en' },
    location: { href: 'http://localhost/' },
    document: { createElement: () => ({ dataset: {}, style: {}, setAttribute() {} }), head: { appendChild() {} } },
    setTimeout, clearTimeout, setInterval, clearInterval, console, URL, TextEncoder, TextDecoder, Intl,
  }
  runInNewContext(bundle, sandbox)
  assert.equal(registrations.length, 2)
  return registrations[0].factory(specifier => platform[specifier])
}

test('the person card reads omni-reading-note, and only ever reads it', async () => {
  const requests = []
  const omni = load({
    fetch: async (url, options) => {
      requests.push({ url, options })
      return { ok: true, json: async () => ({ ok: true, value: { chat: { id: 'chat-1' }, note: null, coverage: null } }) }
    },
  }).omni
  const answer = { chat: { id: 'chat-1' }, note: null, coverage: null }
  assert.deepEqual(await omni.genui.loadReadingNote('chat-1'), answer)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'api/omni-ui')
  assert.equal(requests[0].options.method, 'POST')
  assert.equal(requests[0].options.credentials, 'same-origin')
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    endpoint: 'omni-reading-note',
    payload: { chat: 'chat-1' },
  })
  // A card with no chat id asks nothing: no read, and no write either.
  requests.length = 0
  await assert.rejects(omni.genui.loadReadingNote(''))
  await assert.rejects(omni.genui.loadReadingNote(undefined))
  assert.deepEqual(requests, [])
})

test('the kit hands a plugin its rows and the slice revision, and draws one row', () => {
  const omni = load({ fetch: async () => assert.fail('drawing asks nothing') }).omni
  const rows = [{ chatId: 'chat-1', chat: 'Maria', state: 'reading', page: 3, pages: 12 }]
  const roster = { genui: { revision: 7, batches: { 'run-1': { rows } } } }
  assert.deepEqual(omni.genui.rows(roster, 'run-1'), rows)
  assert.equal(omni.genui.rows(roster, 'nope').length, 0)
  assert.equal(omni.genui.rows(null, 'run-1').length, 0)
  assert.equal(omni.genui.revisionOf(roster), 7)
  assert.equal(omni.genui.revisionOf({}), 0)
  const row = omni.genui.ProgressRow({ row: rows[0] })
  assert.equal(row.type, 'li')
  assert.equal(row.props['data-state'], 'work')
  assert.equal(omni.genui.ProgressRows({ rows: [] }), null)
  assert.equal(omni.genui.CoverageRow({ coverage: null }), null)
})

test('one approval posts start_backfill once, and a stop posts one job id', async () => {
  const requests = []
  const omni = load({
    fetch: async (url, options) => {
      requests.push({ url, options })
      return { ok: true, json: async () => ({ ok: true, value: { runId: 'r1', jobs: [{ chatId: 'c1', jobId: 'j1', state: 'queued' }] } }) }
    },
  }).omni
  assert.equal(typeof omni.genui.BackfillCard, 'function')
  assert.equal(omni.genui.START_BACKFILL, 'start_backfill')
  assert.equal(omni.genui.CANCEL_BACKFILL, 'cancel_backfill')
  const started = await omni.genui.startBackfill({ proposalId: 'p1', chats: ['c1', 'c1', 'c2'], from: '2026-03-01', to: '2026-11-15' })
  assert.deepEqual(started, { runId: 'r1', jobs: [{ chatId: 'c1', jobId: 'j1', state: 'queued' }] })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'api/omni-ui')
  assert.equal(requests[0].options.method, 'POST')
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    endpoint: 'start_backfill',
    payload: { proposalId: 'p1', chats: ['c1', 'c2'], from: '2026-03-01', to: '2026-11-15' },
  })
  await omni.genui.cancelBackfill({ jobId: 'j1' })
  assert.equal(requests.length, 2)
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    endpoint: 'cancel_backfill',
    payload: { jobId: 'j1' },
  })
  // A call that breaks the contract asks nothing: no empty proposal, no empty approval.
  requests.length = 0
  await assert.rejects(omni.genui.startBackfill({ proposalId: 'p1', chats: [], from: '2026-03-01', to: '2026-11-15' }))
  await assert.rejects(omni.genui.startBackfill({ proposalId: 'p1', chats: ['c1'], from: '', to: '2026-11-15' }))
  await assert.rejects(omni.genui.startBackfill({ chats: ['c1'], from: '2026-03-01', to: '2026-11-15' }))
  await assert.rejects(omni.genui.cancelBackfill({}))
  assert.deepEqual(requests, [])
})

test('a registered backfill tool card draws the guarded roster from the built client', () => {
  const hooks = guardBackfillFields({ view: publish => publish, live: publish => publish })
  const invalid = Array(201).fill(null)
  const view = hooks.view(() => ({ omniBackfillProposals: [...invalid, { id: 'p1' }] }))
  const live = hooks.live(() => ({
    omniBackfills: [...invalid, ...Array.from({ length: 30 }, (_, index) => ({ id: `r${index}`, startedAt: 1 + index }))],
  }))
  const omni = load({ fetch: async () => assert.fail('drawing asks nothing') }).omni
  omni.toolCards.register('propose_backfill', ({ roster }) => omni.genui.BackfillCard({ roster }))
  const card = omni.toolCards.renderer('propose_backfill')({ roster: { ...view(), ...live() } })
  const [, proposals, runs] = card.props.children
  assert.equal(proposals[0].props.key, 'p1')
  const [, shown, footer] = runs.props.children
  assert.deepEqual(Array.from(shown, run => run.props.key), ['r0', 'r1', 'r2'])
  assert.equal(footer.props.children[0], 'Showing only 3 runs')
})
