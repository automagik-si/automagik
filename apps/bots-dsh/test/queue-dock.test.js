import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

const { outputFiles } = await build({
  stdin: {
    contents: "export { QueueDock } from './src/client/queue-dock.js'; export { rememberLinkState, forgetKnownStates } from './src/client/cli-login-model.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: initial => [initial, () => {}],
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id',
}
const dom = new JSDOM('<!doctype html><body></body>')
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  document: dom.window.document,
  window: { matchMedia: () => ({ matches: false }) },
  URL,
  require: name => (name === 'react' ? react : {}),
})
const { QueueDock, rememberLinkState, forgetKnownStates } = module.exports

const row = (id, kind, text) => ({ id, source: { kind }, content: [{ type: 'text', text }] })

const dock = (nextTurn, { running = false, pendingSubmissions = [], updateQueue = async () => ({ ok: true }), actions = { reportError: () => {} } } = {}) => QueueDock({
  useSession: selector => selector({ running, pendingSubmissions, subagent: null }),
  useProjection: () => ({ 'next-turn': nextTurn }),
  updateQueue,
  loadImage: async () => 'about:blank',
  actions,
})

// The stub tree holds element objects, function components unevaluated; walk it
// for one class or text leaf.
function collect(node, found = { rows: [], texts: [], controls: [] }) {
  if (node === null || node === undefined || typeof node === 'boolean') return found
  if (typeof node === 'string' || typeof node === 'number') { found.texts.push(String(node)); return found }
  if (Array.isArray(node)) { for (const item of node) collect(item, found); return found }
  if (typeof node !== 'object') return found
  if (typeof node.type === 'function') { collect(node.type(node.props), found); return found }
  if (typeof node.props?.className === 'string' && node.props.className.split(' ').includes('bt-queue-row')) found.rows.push(node)
  if (node.props?.['aria-label'] !== undefined) found.controls.push(node)
  collect(node.props?.children, found)
  return found
}

test('team deliveries in the queue never draw as the user’s own rows (#663)', () => {
  const tree = dock([
    row('u1', 'user', 'ship it when you can'),
    row('b1', 'bot', '[Reply from Writer]\ndone'),
    row('b2', 'bot', '[Group post from Tester]\nlooks fine'),
  ])
  const { rows, texts } = collect(tree)
  assert.equal(rows.length, 1)
  assert.ok(texts.includes('ship it when you can'))
  assert.ok(!texts.some(text => text.includes('[Reply from') || text.includes('[Group post from')))
})

test('a queue of only Bot mail renders nothing', () => {
  const tree = dock([row('b1', 'bot', '[Reply from Writer]\ndone')])
  assert.equal(tree, null)
})

test('the count names only the user’s queued sends', () => {
  const tree = dock([
    row('u1', 'user', 'first'),
    row('u2', 'schedule', 'second, scheduled'),
    row('b1', 'bot', '[Message from Writer]\nnew task'),
  ])
  const { texts } = collect(tree)
  assert.ok(texts.includes('2 queued messages'))
})

test('a user send still in flight shows as sending', () => {
  const tree = dock([], { pendingSubmissions: [{ requestId: 'r1', placement: 'queued', text: 'on its way', attachments: [] }] })
  const { rows, texts } = collect(tree)
  assert.equal(rows.length, 1)
  assert.ok(texts.includes('Sending…'))
})

async function checkQueueEdit(exercise) {
  const original = react.useState
  const state = 'fixture_queue_state'
  const code = `fake-code#${state}`
  let editing = null
  const calls = []
  const notices = []
  const options = { updateQueue: async (...args) => calls.push(args), actions: { showNotice: notice => notices.push(notice) } }
  const render = () => {
    let first = true
    react.useState = initial => {
      if (!first) return original(initial)
      first = false
      return [editing, value => { editing = value }]
    }
    const { controls } = collect(dock([row('u1', 'user', 'Review the plan.')], options))
    return label => controls.find(node => node.props['aria-label'] === label)
  }
  assert.equal(rememberLinkState(`https://example.test/?state=${state}`), true)
  try {
    render()('Edit queued message').props.onClick()
    await exercise({ render, code, calls, notices })
  } finally {
    react.useState = original
    forgetKnownStates()
  }
}

for (const [handler, source] of [['onPaste', 'clipboardData'], ['onDrop', 'dataTransfer']]) {
  test(`queued editing rejects a known sign-in state on ${handler}`, async () => {
    await checkQueueEdit(({ render, code, calls, notices }) => {
      let prevented = false
      render()('Edit queued message').props[handler]({
        [source]: { getData: type => type === 'text/plain' ? code : '' },
        preventDefault: () => { prevented = true },
      })
      assert.equal(prevented, true)
      assert.deepEqual(calls, [])
      assert.match(notices[0], /sign-in code/)
    })
  })
}

for (const [label, submit] of [
  ['Enter', control => control('Edit queued message').props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault: () => {} })],
  ['Save queued message', control => control('Save queued message').props.onClick()],
]) {
  test(`queued editing rejects a known sign-in state on ${label}`, async () => {
    await checkQueueEdit(async ({ render, code, calls, notices }) => {
      render()('Edit queued message').props.onChange({ target: { value: `Review the plan. ${code}` } })
      await submit(render())
      assert.deepEqual(calls, [])
      assert.match(notices[0], /sign-in code/)
    })
  })
}

test('Save queued message submits an ordinary edit', async () => {
  await checkQueueEdit(async ({ render, calls }) => {
    render()('Edit queued message').props.onChange({ target: { value: 'Review the revised plan.' } })
    await render()('Save queued message').props.onClick()
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], 'u1')
    assert.equal(calls[0][1].kind, 'edit')
    assert.equal(calls[0][1].content[0].text, 'Review the revised plan.')
  })
})

test('queued edits stay within the sign-in matcher’s accepted length', async () => {
  await checkQueueEdit(async ({ render, code, calls, notices }) => {
    const max = 1_000_000
    const save = async value => {
      render()('Edit queued message').props.onChange({ target: { value } })
      await render()('Save queued message').props.onClick()
    }
    await save('x'.repeat(max) + code)
    assert.deepEqual(calls, [])
    assert.match(notices[0], /1[,.]?000[,.]?000/)
    await save('x'.repeat(max - code.length) + code)
    assert.deepEqual(calls, [])
    assert.match(notices[1], /sign-in code/)
    await save('x'.repeat(max))
    assert.equal(calls.length, 1)
    assert.equal(calls[0][1].content[0].text.length, max)
  })
})
