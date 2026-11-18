// #1326 K1, G5: the mounted person card must never show one chat's answer under another
// chat's name. Reviewer B's finding 1: switching chatId on a mounted card kept the previous
// note and coverage, and a failed read kept them again; a cleared chat id kept them too.
// The harness keeps hook state across renders (as test/card-hold.test.js does) and drives
// the card's async read, so the identity change, the pending read, the failure and the
// cleared id all run on one mounted instance.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { PersonCard } from './src/client/genui.js'",
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
  useId: () => slot(() => ({ id: 'person-card-id' })).id,
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
  fetch: async () => { throw new Error('the card was given its own read') },
})
const { PersonCard } = module.exports

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
    // A child component (CoverageRow, ProgressRow) draws its own part; these have no hooks,
    // so their words are collected by calling them as the renderer would.
    if (typeof node.type === 'function') return flat(node.type(node.props))
    return flat(node.props?.children)
  }
  return [String(node)]
}
const textOf = node => flat(node).join('\n')

const A = {
  chat: { id: 'a', name: 'Ana' },
  note: { text: 'Who: Ana is a client.\nOpen: the order for Thursday.', readThrough: '2026-11-20T12:00:00Z' },
  coverage: { count: 4400, oldest: '2026-03-02T12:00:00Z', newest: '2026-11-20T12:00:00Z' },
}

test('a mounted person card never shows the previous chat across a change, a pending read, a failure or a cleared id', async () => {
  const b = deferred()
  const load = chatId => (chatId === 'a' ? Promise.resolve(A) : b.promise)
  const card = mount(PersonCard, { chatId: 'a', load })
  card.render()
  await tick()
  let text = textOf(card.render())
  assert.match(text, /Ana/)
  assert.match(text, /Ana is a client\./)
  assert.match(text, /4,400 messages/)
  // The same mounted card switches to B: nothing of A may show before B's read answers.
  const during = textOf(card.render({ chatId: 'b', load }))
  assert.equal(during.includes('Ana'), false, `A's name stayed after the switch:\n${during}`)
  assert.equal(during.includes('Ana is a client.'), false, `A's note stayed after the switch:\n${during}`)
  assert.equal(during.includes('4,400 messages'), false, `A's coverage stayed after the switch:\n${during}`)
  // B's read fails: still nothing of A, and the failure is said plainly.
  b.reject(new Error('omni is not reachable'))
  await tick()
  const failed = textOf(card.render({ chatId: 'b', load }))
  assert.equal(failed.includes('Ana'), false, `A's name came back after B's read failed:\n${failed}`)
  assert.equal(failed.includes('Ana is a client.'), false, `A's note came back after B's read failed:\n${failed}`)
  assert.match(failed, /The note could not be read\./)
  // A cleared chat id must not bring A back either.
  const cleared = textOf(card.render({ chatId: '', load }))
  assert.equal(cleared.includes('Ana'), false, `A's name came back after the id was cleared:\n${cleared}`)
  assert.equal(cleared.includes('Ana is a client.'), false)
  card.unmount()
})

test('a refresh of the same chat keeps its note while it loads and clears it when the read fails', async () => {
  const refresh = deferred()
  let reads = 0
  const load = () => {
    reads += 1
    return reads === 1 ? Promise.resolve(A) : refresh.promise
  }
  const card = mount(PersonCard, { chatId: 'a', load, revision: 0 })
  card.render()
  await tick()
  assert.match(textOf(card.render()), /Ana is a client\./)
  // The same chat refreshes: its note stays while the new read runs.
  const loading = textOf(card.render({ chatId: 'a', load, revision: 1 }))
  assert.match(loading, /Ana is a client\./)
  refresh.reject(new Error('the note reader failed'))
  await tick()
  const failed = textOf(card.render({ chatId: 'a', load, revision: 1 }))
  assert.equal(failed.includes('Ana is a client.'), false, `the stale note stayed after a failed read:\n${failed}`)
  assert.match(failed, /The note could not be read\./)
  card.unmount()
})
