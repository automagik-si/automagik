// New › Start an existing Bot on the page (RFC 0030 delivery 6a): what the menu lists, and the
// store's start: one request, a read after it that never reuses an older one, and polling until
// the Bot is seen live where it was started. The host is a stubbed fetch: nothing starts.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'
import { startChoices, startOutcomeText } from '../src/client/code-start-model.js'

const LEAD = 'b-aaaaaaaaaa'
const DEV = 'b-bbbbbbbbbb'
const V2ONLY = 'b-cccccccccc'
const GLOBAL = 'b-dddddddddd'
const CORE = 'core-test'
const FOLDER = '/src/app'

const row = (id, name, status, blocked = null, seatProject = FOLDER) => ({ id, name, status, blocked, workers: [], terminal: null, main: false,
  ...(status === 'not-running' ? {} : { seatProject }) })
const tree = ({ dev = 'not-running', core = CORE, folder = FOLDER, seat = folder } = {}) => ({
  v: 1, machine: { name: 'here', core },
  projects: [
    { folder: null, name: null, global: true, bots: [row(GLOBAL, 'Everywhere', 'not-running', 'global-bot')] },
    { folder, name: 'app', bots: [row(LEAD, 'Atlas', 'idle'), row(DEV, 'Dev', dev, null, seat), row(V2ONLY, 'Only', 'not-running', 'not-in-roster')] },
  ],
})

test('the menu lists only not-running Bots, the global group last, and blocks a row the host did not check', () => {
  const groups = startChoices(tree())
  assert.deepEqual(groups.map(group => [group.key, group.bots.map(bot => [bot.id, bot.blocked])]), [
    [FOLDER, [[DEV, null], [V2ONLY, 'not-in-roster']]],
    ['global', [[GLOBAL, 'global-bot']]],
  ])
  assert.deepEqual(groups[0].bots[0], { id: DEV, name: 'Dev', folder: FOLDER, launch: null, core: CORE, blocked: null })
  const unchecked = tree()
  delete unchecked.projects[1].bots[1].blocked
  assert.equal(startChoices(unchecked)[0].bots[0].blocked, 'unverified')
  assert.deepEqual(startChoices(tree({ dev: 'working' })).map(group => group.key), [FOLDER, 'global'])
  assert.deepEqual(startChoices({ v: 1, machine: null, projects: [], reason: 'desktop-only' }), [])
  assert.equal(startOutcomeText('started', 'Dev'), 'Dev started.')
  assert.equal(startOutcomeText('no-such-word', 'Dev'), startOutcomeText('unknown', 'Dev'))
})

const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useEffect: () => {},
  useState: initial => [initial, () => {}],
}

/** The store as the page gets it, with `fetch` answered by `answer(endpoint, payload)`. */
async function store(answer) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../src/client/code-side.js', import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent', external: ['react'],
  })
  const calls = []
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body)
    const value = await answer(body.endpoint, body.payload, calls)
    if (value instanceof Error) throw value
    return { ok: true, status: 200, headers: new Map(), json: async () => (value && value.error ? value : { ok: true, value }) }
  }
  const module = { exports: {} }
  const timers = { setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)), clearTimeout }
  const sandbox = { module, exports: module.exports, require: name => (name === 'react' ? react : (() => { throw new Error(`no platform module ${name}`) })()), console, URL, URLSearchParams, ...timers, TextEncoder, TextDecoder, fetch, Headers }
  runInNewContext(bundle.outputFiles[0].text, sandbox)
  return { store: module.exports.codeStore, calls }
}

test('a start asks once, then reads the tree with a call of its own even while an older read is in flight', async () => {
  let release
  const older = new Promise((resolve) => { release = resolve })
  let reads = 0
  const { store: code, calls } = await store(async (endpoint) => {
    if (endpoint === 'code-tree') {
      reads += 1
      if (reads === 1) { await older; return tree() }
      return tree({ dev: 'idle' })
    }
    if (endpoint === 'code-start') { release(); return { outcome: 'started' } }
    throw new Error(endpoint)
  })
  const first = code.loadTree({ fresh: true })
  const outcome = await code.startBot({ id: DEV, name: 'Dev', folder: FOLDER, core: CORE })
  await first
  assert.equal(outcome, 'started')
  // The older read's request goes out on the next tick, after the start's; it answers last of the two.
  assert.deepEqual(calls.map(call => call.endpoint), ['code-start', 'code-tree', 'code-tree'])
  assert.deepEqual(calls[0].payload, { botId: DEV }, 'the page sends the Bot id and nothing else')
  assert.equal(code.snapshot().start.outcome, 'started')
  assert.equal(code.snapshot().tree.projects[1].bots[1].status, 'idle', 'the read after the start is the one kept')
})

test('a refusal that changed nothing reads nothing; a read-only host reads as read only', async () => {
  for (const [answer, outcome] of [
    [{ outcome: 'busy' }, 'busy'],
    [{ outcome: 'desktop-only' }, 'desktop-only'],
    [{ ok: false, error: { code: 'bot/read-only', message: 'This host can only read the team.' } }, 'read-only'],
  ]) {
    const { store: code, calls } = await store(async endpoint => (endpoint === 'code-start' ? answer : tree()))
    assert.equal(await code.startBot({ id: DEV, name: 'Dev', folder: FOLDER, core: CORE }), outcome)
    assert.deepEqual(calls.map(call => call.endpoint), ['code-start'])
    assert.equal(code.snapshot().start.busy, false)
  }
})

test('a lost reply is unknown, and polling waits for the Bot live in its folder on its core', async () => {
  const answers = [tree(), { v: 1, machine: null, projects: [], reason: 'no-core' }, tree({ dev: 'idle', core: 'core-other' }), tree({ dev: 'idle', folder: '/elsewhere' }), tree({ dev: 'idle', seat: '/other-clone' }), tree({ dev: 'working' })]
  const { store: code, calls } = await store(async (endpoint) => {
    if (endpoint === 'code-start') return new Error('connection reset')
    return answers.shift() ?? tree({ dev: 'working' })
  })
  assert.equal(await code.startBot({ id: DEV, name: 'Dev', folder: FOLDER, core: CORE }), 'started')
  assert.equal(calls.filter(call => call.endpoint === 'code-tree').length, 6, 'a failed read, another core, another folder and another checkout\'s seat kept it waiting')
  assert.equal(code.snapshot().start.outcome, 'started')
})

test('a reset ends the polling and an older read lands nowhere', async () => {
  let reads = 0
  const { store: code, calls } = await store(async (endpoint) => {
    if (endpoint === 'code-start') return { outcome: 'pending' }
    reads += 1
    return tree()
  })
  const started = code.startBot({ id: DEV, name: 'Dev', folder: FOLDER, core: CORE })
  while (reads < 2) await new Promise(resolve => setTimeout(resolve, 1))
  code.reset()
  assert.equal(await started, 'pending')
  const after = calls.length
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(calls.length, after, 'no read after the reset')
  assert.equal(code.snapshot().start, null)
  assert.equal(code.snapshot().tree, null)
})

test('a second start while one runs is not sent', async () => {
  let finish
  const { store: code, calls } = await store(async (endpoint) => {
    if (endpoint === 'code-start') return new Promise((resolve) => { finish = () => resolve({ outcome: 'started' }) })
    return tree({ dev: 'idle' })
  })
  const first = code.startBot({ id: DEV, name: 'Dev', folder: FOLDER, core: CORE })
  await new Promise(resolve => setTimeout(resolve, 1))
  await code.startBot({ id: V2ONLY, name: 'Only', folder: FOLDER, core: CORE })
  finish()
  await first
  assert.equal(calls.filter(call => call.endpoint === 'code-start').length, 1)
})

test('a pending start keeps the control busy until it settles; a reset while the start is out reads nothing', async () => {
  let reads = 0
  const { store: code, calls } = await store(async (endpoint) => {
    if (endpoint === 'code-start') return { outcome: 'pending' }
    reads += 1
    return reads < 3 ? tree() : tree({ dev: 'idle' })
  })
  const first = code.startBot({ id: DEV, name: 'Dev', folder: FOLDER, core: CORE })
  while (reads < 1) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(code.snapshot().start.busy, true, 'pending holds the control')
  await code.startBot({ id: V2ONLY, name: 'Only', folder: FOLDER, core: CORE })
  assert.equal(await first, 'started', 'the second click did not end the first reconciliation')
  assert.equal(code.snapshot().start.busy, false)
  assert.equal(calls.filter(call => call.endpoint === 'code-start').length, 1)

  let answer
  const late = await store(async (endpoint) => (endpoint === 'code-start' ? new Promise((resolve) => { answer = resolve }) : tree()))
  const out = late.store.startBot({ id: DEV, name: 'Dev', folder: FOLDER, core: CORE })
  await new Promise(resolve => setTimeout(resolve, 1))
  late.store.reset()
  answer({ outcome: 'started' })
  await out
  assert.deepEqual(late.calls.map(call => call.endpoint), ['code-start'], 'no read after the reset')
  assert.equal(late.store.snapshot().tree, null)
})
