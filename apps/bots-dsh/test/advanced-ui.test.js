import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'

const compiled = await build({ entryPoints: [new URL('../src/client/advanced-settings.js', import.meta.url).pathname], bundle: true, format: 'cjs', platform: 'node', write: false, external: ['react'] })
function load(react, clock = { setInterval, clearInterval }) {
  const module = { exports: {} }
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, ...clock, require: () => react })
  return module.exports
}
const { countText, statsRows, contextSummary } = load({ createElement() {}, useState() {}, useEffect() {} })

test('Advanced statistics keep unknown different from a known zero', () => {
  assert.equal(countText(null), 'Unknown')
  assert.equal(countText(undefined), 'Unknown')
  assert.equal(countText(0), '0')
  assert.equal(countText(NaN), 'Unknown')
  const scope = { allIn: { input: null, output: 0, attempts: 2 }, byKind: { memory: { input: 7, output: 0, attempts: 1 } } }
  const rows = statsRows(scope)
  assert.equal(rows[0].label, 'All-in')
  assert.equal(rows[0].totals.input, null)
  assert.equal(rows[1].label, 'memory')
  assert.equal(rows[1].totals.input, 7)
  assert.equal(statsRows(null).length, 0)
})

test('Context status identifies measured, estimated and unavailable evidence', () => {
  assert.match(contextSummary({ usage: { tokens: 0, source: 'measured' }, lines: { usable: 100, check: 80, hard: 95 }, counts: { parts: 2, checkpoints: 0 } }), /0 tokens.*measured/)
  assert.match(contextSummary({ usage: { tokens: 22, source: 'estimated' }, lines: null, counts: { parts: 1, checkpoints: null } }), /22 tokens.*estimated/)
  assert.match(contextSummary({ usage: { tokens: null, source: 'unavailable' }, lines: null, counts: { parts: 1, checkpoints: null } }), /Unavailable/)
  assert.equal(contextSummary(null), 'Loading…')
})

// Hook lifecycle fixture, not a browser substitute. The separate native fixture runs
// the actual React bundle. Here promises can be settled in deliberately hostile order.
function hooks() {
  const states = [], effects = []
  let stateCursor = 0, effectCursor = 0, queued = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState(initial) {
      const index = stateCursor++
      if (!(index in states)) states[index] = initial
      return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
    },
    useRef(initial) {
      const index = stateCursor++
      if (!(index in states)) states[index] = { current: initial }
      return states[index]
    },
    useEffect(effect, deps) {
      const index = effectCursor++
      const prior = effects[index]
      if (prior && deps.every((value, key) => Object.is(value, prior.deps[key]))) return
      queued.push(() => { prior?.off?.(); effects[index] = { deps, off: effect() } })
    },
  }
  return { react, render: make => { stateCursor = 0; effectCursor = 0; queued = []; const tree = make(); for (const effect of queued) effect(); return tree }, close: () => { for (const effect of effects) effect?.off?.() } }
}
const find = (node, predicate) => {
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  for (const child of node.children ?? []) { const match = find(child, predicate); if (match) return match }
  return null
}
const flush = async () => { for (let n = 0; n < 24; n++) await Promise.resolve() }

test('Advanced default, single-flight polling, late read isolation and separate context actions', async () => {
  const lifecycle = hooks()
  const ticks = new Set()
  const { AdvancedSettings } = load(lifecycle.react, { setInterval: callback => { ticks.add(callback); return callback }, clearInterval: callback => ticks.delete(callback) })
  const mutations = []
  let contextReads = 0
  let resolveA
  const slow = new Promise(resolve => { resolveA = resolve })
  const context = (id, tokens) => ({ id, sessionId: `${id}-part`, status: 'idle', readOnly: false, policy: { checkRatio: .8, recentTokens: 16384 }, usage: { tokens, source: 'measured' }, lines: { usable: 100, check: 80, hard: 95 }, counts: { parts: 1, checkpoints: 0 }, markers: {}, canCheckpoint: true })
  const actions = {
    contextStatus: id => { contextReads += 1; return id === 'a' ? slow : Promise.resolve(context(id, 22)) },
    usageStats: async () => ({ scopes: {}, coverage: { status: 'complete' } }),
    memoryReviewStatus: async () => ({ enabled: true, allowed: true, pending: false, running: false, tidy: { enabled: false, allowed: true, always: false } }),
    checkpointBot: async (...args) => { mutations.push(['checkpoint', ...args]) },
    freshConversation: async id => { mutations.push(['fresh', id]) },
  }
  const primitives = { Card() {}, Row() {}, SwitchRow() {} }
  const render = bot => lifecycle.render(() => AdvancedSettings({ bot, roster: {}, actions, save: patch => mutations.push(['save', bot.id, patch]), ...primitives }))
  const button = (tree, name) => find(tree, node => node.type === 'button' && node.children.includes(name))
  try {
    const simple = render({ id: 'a', sessionId: 'a-part' })
    const toggle = find(simple, node => node.props.label === 'Advanced Bot')
    assert.equal(toggle.props.on, false)
    assert.equal(find(simple, node => node.props.title === 'Context'), null)
    toggle.props.onChange(true)
    assert.equal(JSON.stringify(mutations[0]), JSON.stringify(['save', 'a', { advanced: true }]))
    render({ id: 'a', sessionId: 'a-part', advanced: true })
    await flush()
    for (let tick = 0; tick < 20; tick++) for (const callback of ticks) callback()
    await flush()
    assert.equal(contextReads, 1, 'slow reads cannot accumulate overlapping polls')
    render({ id: 'b', sessionId: 'b-part', advanced: true })
    await flush()
    let tree = render({ id: 'b', sessionId: 'b-part', advanced: true })
    assert.equal(find(tree, node => node.props['data-context-usage']).children[0], 'Loading…')
    assert.equal(contextReads, 1, 'new Bot waits for the previous read without showing it')
    resolveA(context('a', 999)); await flush()
    tree = render({ id: 'b', sessionId: 'b-part', advanced: true })
    assert.equal(contextReads, 2, 'only one current replacement read starts')
    assert.equal(find(tree, node => node.props['data-context-usage']).children[0], '22 tokens · measured')
    // The daily tidy is off until the person turns it on, here, for this Bot.
    const tidy = find(tree, node => node.props.label === 'Daily memory tidy')
    assert.deepEqual([tidy.props.on, tidy.props.disabled], [false, false])
    tidy.props.onChange(true)
    assert.equal(JSON.stringify(mutations.at(-1)), JSON.stringify(['save', 'b', { memoryTidy: true }]))
    await button(tree, 'Checkpoint now').props.onClick(); await flush()
    assert.deepEqual(mutations.at(-1), ['checkpoint', 'b', 'b-part'])
    tree = render({ id: 'b', sessionId: 'b-part', advanced: true }); await flush()
    button(tree, 'Start new part').props.onClick()
    assert.equal(mutations.some(entry => entry[0] === 'fresh'), false)
    tree = render({ id: 'b', sessionId: 'b-part', advanced: true })
    button(tree, 'Confirm new part').props.onClick(); await flush()
    assert.deepEqual(mutations.at(-1), ['fresh', 'b'])
  } finally { lifecycle.close() }
})
