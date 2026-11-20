// Claude Code's native subagents as workers under a Bot's row (issue 1564). acp-dsh groups
// each subagent's calls under its Agent/Task call (acpAgents.nativeWorkers()); the host maps
// them onto Bots as the live answer's `work.native`; the sidebar draws them under the Bot's
// row the way BotThreads hangs its tasks, and a worker opens its steps. The rows and the
// popover are rendered with the React DSH ships, in jsdom, as in details-focus.test.js.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'
import { nativeWorkersView } from '../src/host/native-workers.js'

const plugin = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = process.env.DSH_HARNESS
const require = createRequire(join(harness, 'package.json'))
const { JSDOM } = require('jsdom')
const assets = join(harness, 'node_modules/@deepseek-ai/dsh-web-frontend/dist/assets')
const frontend = readFileSync(join(assets, readdirSync(assets).find(name => /^index-.*\.js$/.test(name))), 'utf8')
const seed = /function (\w+)\(\)\{return\{react:[\s\S]*?\}\}/.exec(frontend)
assert.ok(seed, 'the declared native harness supplies its React seed factory')
const seedsBuild = await build({ stdin: { contents: `${frontend.slice(0, seed.index + seed[0].length)}; globalThis.nativeSeeds = ${seed[1]}();`, resolveDir: assets }, bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent' })
const seedDom = new JSDOM('<!doctype html><html><body></body></html>')
const seedContext = { window: seedDom.window, document: seedDom.window.document, navigator: seedDom.window.navigator, MutationObserver: seedDom.window.MutationObserver, fetch: async () => { throw new Error('seed bootstrap must not fetch') }, console, setTimeout, clearTimeout, performance, TextEncoder, TextDecoder }
runInNewContext(seedsBuild.outputFiles[0].text, seedContext)
const nativeRequire = name => seedContext.nativeSeeds[name] ?? require(name)
const React = nativeRequire('react')
const { createRoot } = nativeRequire('react-dom/client')
const { flushSync } = nativeRequire('react-dom')
const tick = () => new Promise(resolve => setTimeout(resolve, 10))
const act = async (fn) => { flushSync(fn); await tick() }
const { outputFiles } = await build({
  stdin: { contents: "export { NativeWorkers, WORKERS_SHOWN, runningWorkers, workerLine, NATIVE_WORKERS_CSS } from './src/client/native-workers.js'", resolveDir: plugin },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

function mount(t) {
  const dom = new JSDOM('<body><div id="mount"></div><div id="elsewhere">elsewhere</div></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const { window } = dom
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, require: name => nativeRequire(name),
    window, document: window.document, navigator: window.navigator, localStorage: window.localStorage, matchMedia: window.matchMedia,
    MutationObserver: window.MutationObserver, Element: window.Element, getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    innerHeight: 820, queueMicrotask, setTimeout, clearTimeout, setInterval, clearInterval, console, performance, URL,
  })
  const root = createRoot(window.document.querySelector('#mount'))
  t.after(async () => { try { await act(() => root.unmount()) } catch {} dom.window.close() })
  return { window, document: window.document, root, ...module.exports }
}

const NOW = Date.now()
const bot = { id: 'pip', name: 'Pip' }
// What acp-dsh's workersOf returns for the three states, as the host passes it on: in the
// order the calls came, so the oldest first.
const RUNNING = { id: 'toolu_a', title: 'Review the adapter bundle', state: 'running', at: NOW, steps: [
  { id: 'a1', title: 'find the adapter version', tool: 'Grep', state: 'done' },
  { id: 'a2', title: 'read the session update path', tool: 'Read', state: 'running' },
] }
const DONE = { id: 'toolu_b', title: 'Audit memory writes', state: 'done', result: '2 files changed · 4 notes kept', at: NOW - 4 * 60_000, steps: [
  { id: 'b1', title: 'read the memory doors', tool: 'Read', state: 'done' },
  { id: 'b2', title: 'compare both memory stores', tool: 'Grep', state: 'done' },
  { id: 'b3', title: 'keep the app memory as the source', tool: 'Edit', state: 'done' },
] }
const FAILED = { id: 'toolu_c', title: 'Check the approval path', state: 'failed', result: 'Bash exited 1 · approval path missing', at: NOW - 9 * 60_000, steps: [
  { id: 'c1', title: 'list the approval levels', tool: 'Read', state: 'done' },
  { id: 'c2', title: 'run the permission probe', tool: 'Bash', state: 'failed' },
] }
const WORKERS = [FAILED, DONE, RUNNING]
const ages = { [NOW]: 'now', [NOW - 4 * 60_000]: '4m', [NOW - 9 * 60_000]: '9m' }
const age = ms => ages[ms] ?? '?'

function render(env, { workers = WORKERS, wide = true } = {}) {
  const work = { native: { pip: workers } }
  return act(() => env.root.render(React.createElement(env.NativeWorkers, { bot, wide, age, useWork: pick => pick(work) })))
}
const rows = document => [...document.querySelectorAll('#mount .bt-worker')]
const row = (document, id) => document.querySelector(`#mount [data-worker="${id}"]`)
const pop = document => document.querySelector('.bt-worker-pop')

test("a Bot's native subagents hang under its row: running, done and failed, each with its line", async (t) => {
  const env = mount(t)
  await render(env)
  const { document } = env
  const group = document.querySelector('#mount .bt-threads')
  assert.ok(group, 'the workers use the threads group the tasks use')
  assert.equal(group.getAttribute('role'), 'group')
  assert.equal(group.getAttribute('aria-label'), 'Subagents Pip started')
  assert.deepEqual(rows(document).map(node => node.dataset.state), ['running', 'done', 'failed'])
  assert.deepEqual(rows(document).map(node => node.querySelector('.bt-thread-title').textContent), ['Review the adapter bundle', 'Audit memory writes', 'Check the approval path'])
  assert.deepEqual(rows(document).map(node => node.querySelector('.bt-thread-age').textContent), ['now', '4m', '9m'])
  // The running worker says what it is doing; an ended one, how it ended.
  assert.deepEqual(rows(document).map(node => node.querySelector('.bt-worker-line').textContent), [
    'read the session update path…', '2 files changed · 4 notes kept', 'Bash exited 1 · approval path missing',
  ])
  // The sidebar's own spinner while it runs, a mark once it ended.
  assert.ok(row(document, 'toolu_a').querySelector('.bt-thread-spin'))
  assert.ok(row(document, 'toolu_b').querySelector('.bt-thread-mark'))
  assert.equal(row(document, 'toolu_c').dataset.state, 'failed')
  assert.equal(row(document, 'toolu_c').getAttribute('aria-label'), 'Check the approval path, Failed, Bash exited 1 · approval path missing')
  assert.equal(pop(document), null, 'no steps until a worker is opened')
})

test('opening a worker shows its status, result and steps; Close, Escape and a click elsewhere close it', async (t) => {
  const env = mount(t)
  await render(env)
  const { document, window } = env
  await act(() => row(document, 'toolu_b').click())
  let popover = pop(document)
  assert.ok(popover, 'the steps open in a popover')
  assert.equal(popover.getAttribute('role'), 'dialog')
  assert.ok(popover.classList.contains('bt-menu'), 'the popover is the sidebar\'s own menu surface')
  assert.equal(row(document, 'toolu_b').getAttribute('aria-expanded'), 'true')
  assert.equal(popover.querySelector('.bt-worker-title').textContent, 'Audit memory writes')
  assert.equal(popover.querySelector('.bt-worker-badge').textContent, 'Done')
  assert.match(popover.textContent, /Result: 2 files changed · 4 notes kept/)
  const steps = [...popover.querySelectorAll('.bt-worker-step')]
  assert.deepEqual(steps.map(step => step.querySelector('.bt-menu-label').textContent), ['read the memory doors', 'compare both memory stores', 'keep the app memory as the source'])
  assert.deepEqual(steps.map(step => step.querySelector('.bt-menu-hint').textContent), ['Read · Done', 'Grep · Done', 'Edit · Done'])
  const close = [...popover.querySelectorAll('button')].find(node => node.textContent === 'Close')
  await act(() => close.click())
  assert.equal(pop(document), null)

  // Another worker: the running one says so, and its current step is marked running.
  await act(() => row(document, 'toolu_a').click())
  popover = pop(document)
  assert.match(popover.textContent, /Result: still running/)
  assert.deepEqual([...popover.querySelectorAll('.bt-worker-step')].map(step => step.dataset.state), ['done', 'running'])
  await act(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  assert.equal(pop(document), null, 'Escape closes it')

  await act(() => row(document, 'toolu_c').click())
  assert.equal(pop(document).querySelector('.bt-worker-badge').dataset.state, 'failed')
  await act(() => document.querySelector('#elsewhere').dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true })))
  assert.equal(pop(document), null, 'a click elsewhere closes it')

  // The same worker's button toggles it.
  await act(() => row(document, 'toolu_c').click())
  await act(() => row(document, 'toolu_c').click())
  assert.equal(pop(document), null)
})

test('an open worker follows the live answer, and closes when its worker is gone', async (t) => {
  const env = mount(t)
  await render(env)
  const { document } = env
  await act(() => row(document, 'toolu_a').click())
  const next = [{ ...RUNNING, state: 'done', result: 'All read', steps: [...RUNNING.steps.map(step => ({ ...step, state: 'done' })), { id: 'a3', title: 'search for parentToolUseId', tool: 'Grep', state: 'done' }] }]
  await render(env, { workers: next })
  assert.equal(pop(document).querySelector('.bt-worker-badge').textContent, 'Done')
  assert.equal(pop(document).querySelectorAll('.bt-worker-step').length, 3)
  await render(env, { workers: [DONE] })
  assert.equal(pop(document), null)
  assert.deepEqual(rows(document).map(node => node.dataset.state), ['done'])
})

test('no workers, or the narrow rail, draw nothing; past three the rest fold into a count', async (t) => {
  const env = mount(t)
  const { document } = env
  await render(env, { workers: [] })
  assert.equal(document.querySelector('#mount').children.length, 0)
  await render(env, { wide: false })
  assert.equal(document.querySelector('#mount').children.length, 0)
  const many = Array.from({ length: 6 }, (_, index) => ({ id: `w${index}`, title: `Worker ${index}`, state: index === 0 ? 'running' : 'done', steps: [] }))
  await render(env, { workers: many })
  assert.equal(rows(document).length, env.WORKERS_SHOWN)
  // The running one first, then the newest.
  assert.deepEqual(rows(document).map(node => node.querySelector('.bt-thread-title').textContent), ['Worker 0', 'Worker 5', 'Worker 4'])
  const more = document.querySelector('#mount .bt-thread-more')
  assert.equal(more.textContent, '+3 more')
  await act(() => more.click())
  assert.equal(rows(document).length, 6)
  // A worker with no step yet says it is starting, and its popover says there are none.
  await render(env, { workers: [{ id: 'w', title: 'Fresh', state: 'running', steps: [] }] })
  assert.equal(rows(document)[0].querySelector('.bt-worker-line').textContent, 'Starting…')
  assert.equal(rows(document)[0].querySelector('.bt-thread-age'), null)
  await act(() => row(document, 'w').click())
  assert.match(pop(document).textContent, /No steps yet\./)
  assert.equal(env.runningWorkers({ native: { pip: WORKERS } }, 'pip'), 1)
  assert.equal(env.runningWorkers({}, 'pip'), 0)
})

test('the look is the sidebar\'s: only --bt-* tokens, no colour of its own', (t) => {
  const { NATIVE_WORKERS_CSS } = mount(t)
  assert.doesNotMatch(NATIVE_WORKERS_CSS, /#[0-9a-f]{3,8}\b|rgba?\(/i)
})

// The approved mock (#1568, 2-steps-light): the Done badge is the accent one, as Running; only
// Failed has its own. The row's done mark stays green.
test('the Done badge is the accent badge of the approved mock; the row\'s done mark stays green', (t) => {
  const { NATIVE_WORKERS_CSS } = mount(t)
  const rules = NATIVE_WORKERS_CSS.split('\n').filter(line => line.startsWith('.bt-worker-badge'))
  assert.deepEqual(rules.map(line => line.slice(0, line.indexOf('{'))), ['.bt-worker-badge', '.bt-worker-badge[data-state=failed]'])
  assert.match(rules[0], /background:var\(--bt-accent-soft\);color:var\(--bt-accent\)/)
  assert.doesNotMatch(rules.join('\n'), /--bt-green/)
  assert.match(NATIVE_WORKERS_CSS, /\.bt-thread\[data-state=done\] \.bt-thread-mark\{background:var\(--bt-green\)\}/)
})

// A worker DSH closed with its turn (Stop, or the agent went away): acp-dsh says failed and
// stopped. Its row and popover say Stopped, never Done, and its unfinished steps failed.
test('a worker stopped with its turn reads Stopped, under a Failed badge', async (t) => {
  const env = mount(t)
  const STOPPED = { id: 'toolu_s', title: 'Review the adapter bundle', state: 'failed', result: 'Stopped', stopped: true, at: NOW, steps: [
    { id: 's1', title: 'find the adapter version', tool: 'Grep', state: 'done' },
    { id: 's2', title: 'read the session update path', tool: 'Read', state: 'failed' },
  ] }
  await render(env, { workers: [STOPPED] })
  const { document } = env
  assert.equal(rows(document)[0].dataset.state, 'failed')
  assert.equal(rows(document)[0].querySelector('.bt-worker-line').textContent, 'Stopped')
  assert.equal(row(document, 'toolu_s').getAttribute('aria-label'), 'Review the adapter bundle, Failed, Stopped')
  assert.equal(env.workerLine({ ...STOPPED, result: 'half a report' }), 'Stopped', 'a stopped worker\'s partial text is not its result')
  await act(() => row(document, 'toolu_s').click())
  assert.equal(pop(document).querySelector('.bt-worker-badge').textContent, 'Failed')
  assert.match(pop(document).textContent, /Result: Stopped/)
  assert.deepEqual([...pop(document).querySelectorAll('.bt-worker-step .bt-menu-hint')].map(node => node.textContent), ['Grep · Done', 'Read · Failed'])
})

test('the host maps each Session\'s workers onto its Bot and keeps only what the row draws', () => {
  const rt = {
    chatOwners: new Map([['chat-pip', 'pip'], ['chat-omni', 'omni']]),
    groupOwners: new Map([['room-session', { botId: 'pip', roomId: 'room' }]]),
  }
  const long = 'x'.repeat(400)
  const acp = {
    nativeWorkers: () => ({
      'chat-pip': [{ id: 'w1', title: `  Review\n the bundle  ${long}`, state: 'running', steps: [{ id: 's1', title: 'Read a file', tool: 'Read', state: 'done', extra: 'dropped' }], prompt: 'never sent' }],
      'room-session': [{ id: 'w2', title: 'In the group', state: 'weird', result: 'ok', at: 5, steps: [] }, { id: 'w4', title: 'Stopped one', state: 'failed', result: 'Stopped', stopped: true, steps: [] }, { id: 'w5', title: 'Odd flag', state: 'done', stopped: 'yes', steps: [] }],
      'chat-omni': [{ title: 'no id' }],
      'stray-session': [{ id: 'w3', title: 'Nobody owns me', state: 'done', steps: [] }],
    }),
  }
  const view = nativeWorkersView(rt, acp)
  assert.deepEqual(Object.keys(view), ['pip'])
  assert.deepEqual(view.pip.map(worker => worker.id), ['w1', 'w2', 'w4', 'w5'])
  // DSH's own stop passes on as it came; only a true flag does.
  assert.deepEqual([view.pip[2].state, view.pip[2].result, view.pip[2].stopped], ['failed', 'Stopped', true])
  assert.equal('stopped' in view.pip[3], false)
  assert.equal('stopped' in view.pip[0], false)
  assert.equal(view.pip[0].title.length, 160)
  assert.match(view.pip[0].title, /^Review the bundle x/)
  assert.deepEqual(view.pip[0].steps, [{ id: 's1', title: 'Read a file', tool: 'Read', state: 'done' }])
  assert.equal('prompt' in view.pip[0], false)
  assert.equal(view.pip[1].state, 'running', 'an unknown state is shown as running, never passed on')
  assert.equal(view.pip[1].result, 'ok')
  // No acp-dsh, or one that throws: nothing to draw.
  assert.deepEqual(nativeWorkersView(rt, undefined), {})
  assert.deepEqual(nativeWorkersView(rt, { nativeWorkers: () => { throw new Error('gone') } }), {})
})

test('opening a worker focuses its dialog and Escape inside returns focus to the opener', async (t) => {
  const env = mount(t)
  await render(env)
  const { document, window } = env
  const opener = row(document, RUNNING.id)
  await act(() => opener.click())
  const dialog = pop(document)
  assert.equal(dialog.tabIndex, -1)
  assert.equal(document.activeElement, dialog)
  const close = dialog.querySelector('button')
  close.focus()
  await act(() => close.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  assert.equal(pop(document), null)
  assert.equal(document.activeElement, opener)
})

test('Close returns focus to the worker opener', async (t) => {
  const env = mount(t)
  await render(env)
  const { document } = env
  const opener = row(document, DONE.id)
  await act(() => opener.click())
  await act(() => pop(document).querySelector('button').click())
  assert.equal(pop(document), null)
  assert.equal(document.activeElement, opener)
})

test('Escape from an outside input closes the worker dialog and preserves input focus', async (t) => {
  const env = mount(t)
  await render(env)
  const { document, window } = env
  const input = document.createElement('input')
  document.body.append(input)
  await act(() => row(document, RUNNING.id).click())
  input.focus()
  await act(() => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  assert.equal(pop(document), null)
  assert.equal(document.activeElement, input)
})

test('an outside press closes the worker dialog and preserves focus taken by an input', async (t) => {
  const env = mount(t)
  await render(env)
  const { document, window } = env
  const input = document.createElement('input')
  document.body.append(input)
  await act(() => row(document, RUNNING.id).click())
  await act(() => {
    input.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }))
    input.focus() // jsdom does not perform the browser's default focus action.
  })
  assert.equal(pop(document), null)
  assert.equal(document.activeElement, input)
})

test('pressing a non-focusable div returns focus to the worker opener', async (t) => {
  const env = mount(t)
  await render(env)
  const { document, window } = env
  const opener = row(document, RUNNING.id)
  await act(() => opener.click())
  await act(() => document.querySelector('#elsewhere').dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true })))
  assert.equal(pop(document), null)
  assert.equal(document.activeElement, opener)
})

test('activating another focused worker button focuses its new dialog', async (t) => {
  const env = mount(t)
  await render(env)
  const { document } = env
  await act(() => row(document, RUNNING.id).click())
  const firstDialog = pop(document)
  const second = row(document, DONE.id)
  second.focus()
  await act(() => second.click()) // Keyboard activation produces a click without a pointerdown.
  assert.notEqual(pop(document), firstDialog)
  assert.equal(pop(document).querySelector('.bt-worker-title').textContent, DONE.title)
  assert.equal(document.activeElement, pop(document))
})

test('a live step update keeps focus on the open worker dialog’s Close button', async (t) => {
  const env = mount(t)
  await render(env)
  const { document } = env
  await act(() => row(document, RUNNING.id).click())
  const close = pop(document).querySelector('button')
  close.focus()
  const updated = { ...RUNNING, steps: [...RUNNING.steps, { id: 'a3', title: 'Check the log', state: 'running' }] }
  await render(env, { workers: [FAILED, DONE, updated] })
  assert.equal(pop(document).querySelectorAll('[role="listitem"]').length, 3)
  assert.equal(document.activeElement, close)
})

test('removing a focused worker dialog sends focus to the first remaining worker button', async (t) => {
  const env = mount(t)
  await render(env)
  const { document } = env
  await act(() => row(document, RUNNING.id).click())
  pop(document).querySelector('button').focus()
  await render(env, { workers: [FAILED, DONE] })
  assert.equal(pop(document), null)
  assert.equal(document.activeElement, row(document, DONE.id))
})

test('removing an open worker preserves focus on an outside control', async (t) => {
  const env = mount(t)
  await render(env)
  const { document } = env
  const input = document.createElement('input')
  document.body.append(input)
  await act(() => row(document, RUNNING.id).click())
  input.focus()
  await render(env, { workers: [FAILED, DONE] })
  assert.equal(pop(document), null)
  assert.equal(document.activeElement, input)
})

test('removing the last worker closes its focused dialog with no worker to receive focus', async (t) => {
  const env = mount(t)
  await render(env, { workers: [RUNNING] })
  const { document } = env
  await act(() => row(document, RUNNING.id).click())
  assert.equal(document.activeElement, pop(document))
  await render(env, { workers: [] })
  assert.equal(pop(document), null)
  assert.equal(document.activeElement, document.body)
})

const pipWorkerIds = (chat, room) => nativeWorkersView({
  chatOwners: new Map([['chat', bot.id]]),
  groupOwners: new Map([['room', { botId: bot.id }]]),
}, { nativeWorkers: () => ({ chat, room }) }).pip.map(worker => worker.id)

test('the host interleaves workers from two Sessions by time, keeping their order at equal times', () => {
  const chat = [{ id: 'c1', at: 1 }, { id: 'c2', at: 3 }, { id: 'c3' }]
  const room = [{ id: 'r1', at: 2 }, { id: 'r2', at: 3 }, { id: 'r3', at: 4 }]
  assert.deepEqual(pipWorkerIds(chat, room), ['c1', 'r1', 'c2', 'c3', 'r2', 'r3'])
})

test('the host keeps the twelve newest workers across Sessions', () => {
  const chat = Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, at: 2 * i }))
  const room = Array.from({ length: 7 }, (_, i) => ({ id: `r${i}`, at: 2 * i + 1 }))
  assert.deepEqual(pipWorkerIds(chat, room), ['c1', 'r1', 'c2', 'r2', 'c3', 'r3', 'c4', 'r4', 'c5', 'r5', 'c6', 'r6'])
})

test('a leading undated worker in the second Session sorts first and drops out at the cap', () => {
  const chat = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, at: 2 * i + 1 }))
  const room = [{ id: 'undated' }, ...Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, at: 2 * i + 2 }))]
  const order = ['c0', 'r0', 'c1', 'r1', 'c2', 'r2', 'c3', 'r3', 'c4', 'r4', 'c5']
  assert.deepEqual(pipWorkerIds(chat, room), ['undated', ...order])
  assert.deepEqual(pipWorkerIds(chat, [...room, { id: 'r5', at: 12 }]), [...order, 'r5'])
})
