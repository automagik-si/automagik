import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/context-menu.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

// React's dependency comparison: a previous hook of the wrong kind can supply undefined.
function areHookInputsEqual(nextDeps, prevDeps) {
  if (prevDeps === null) return false
  for (let i = 0; i < prevDeps.length && i < nextDeps.length; i++) {
    if (!Object.is(nextDeps[i], prevDeps[i])) return false
  }
  return true
}

test('the exit render keeps the work hook when deletion removes the Bot', () => {
  const slots = []
  let index = 0
  let mounting = true
  const slot = init => {
    if (mounting) slots[index] = { memoizedState: init() }
    const current = slots[index++]
    assert.ok(current, 'rendered more hooks than during the previous render')
    return current
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'fragment',
    useState: value => [slot(() => typeof value === 'function' ? value() : value).memoizedState, () => {}],
    useRef: value => slot(() => ({ current: value })).memoizedState,
    useEffect: () => { slot(() => ({ tag: 'effect' })) },
    useLayoutEffect: () => { slot(() => ({ tag: 'effect' })) },
    useMemo: (make, deps = null) => {
      const current = slot(() => [make(), deps])
      const previous = current.memoizedState
      if (!mounting && previous !== null && deps !== null && !areHookInputsEqual(deps, previous[1])) {
        current.memoizedState = [make(), deps]
      }
      return current.memoizedState[0]
    },
    useSyncExternalStore: (_subscribe, get) => slot(get).memoizedState,
  }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, document: { body: {}, activeElement: null }, navigator: {},
    window: { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} },
    require: name => ({ react, 'react-dom': { createPortal: child => child } })[name] ?? {},
  })
  const work = { waiting: { b: { waits: [{ id: 'w', to: 'tester', name: 'Tester' }] } } }
  function useWork(select) {
    react.useRef(null)
    const [get] = react.useMemo(() => [() => select(work)], [select])
    const value = react.useSyncExternalStore(() => () => {}, get)
    react.useEffect(() => {}, [value])
    return value
  }
  const bot = { id: 'b', name: 'Writer', sessionId: 'b', parts: [] }
  const roster = { bots: [bot], rooms: [], byId: { b: bot }, roomsById: {}, mainBotIds: [], sections: [] }
  const menu = { kind: 'bot', id: 'b', x: 10, y: 10 }
  const actions = { closeMenu() {}, abandonWork() {} }
  const render = (roster, leaving) => {
    index = 0
    const tree = module.exports.ContextMenu({ menu, roster, actions, useWork, leaving })
    mounting = false
    assert.equal(index, slots.length, 'the render keeps every hook slot')
    return tree
  }
  assert.match(JSON.stringify(render(roster, false)), /Give up waiting for Tester/)
  assert.equal(render({ ...roster, bots: [], byId: {} }, true), null)
})
