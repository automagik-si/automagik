import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: { contents: [
    "export { NewSolver } from './src/client/solver-new.js'",
    "export { CommandPalette } from './src/client/palette.js'",
    "export { teamActions } from './src/client/team-actions.js'",
  ].join('\n'), resolveDir: import.meta.dirname + '/../..' },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let current
const slot = (make) => {
  const index = current.index++
  return current.slots[index] ??= make()
}
const effect = (make, deps) => {
  const cell = slot(() => ({}))
  if (!cell.deps || deps === undefined || deps.some((value, index) => value !== cell.deps[index])) {
    current.effects.push(() => { cell.stop?.(); cell.stop = make(); cell.deps = deps })
  }
}
const react = {
  Fragment: 'fragment',
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  createContext: () => ({}),
  useState: (initial) => {
    const cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
  },
  useRef: initial => slot(() => ({ current: initial })),
  useEffect: effect, useLayoutEffect: effect,
  useMemo: make => make(),
  useCallback: fn => fn,
  useContext: () => undefined,
  useSyncExternalStore: (_subscribe, get) => get(),
}
const module = { exports: {} }
const timers = []
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { FishLogo: 'fish', MarkdownText: () => null, writeClipboard: () => {} }
    throw new Error(`no platform module ${name}`)
  },
  window: { addEventListener() {}, removeEventListener() {}, innerWidth: 1200, innerHeight: 800, matchMedia: () => ({ matches: false }) },
  document: { querySelector: () => null, documentElement: { addEventListener() {}, removeEventListener() {} }, addEventListener() {}, removeEventListener() {} },
  requestAnimationFrame: () => 0, cancelAnimationFrame() {}, performance: { now: () => 0 },
  setTimeout: (fn) => { timers.push(fn); return timers.length }, clearTimeout() {},
})
export const { NewSolver, CommandPalette, teamActions } = module.exports

export const mount = (Component, props) => {
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
  }
  return instance
}
export const all = (node, check) => {
  if (Array.isArray(node)) return node.flatMap(child => all(child, check))
  if (!node || typeof node !== 'object') return []
  return [...(check(node) ? [node] : []), ...all(node.props?.children, check)]
}
export const text = (node) => {
  if (Array.isArray(node)) return node.map(text).join('')
  if (!node || typeof node !== 'object') return String(node ?? '')
  return text(node.props?.children)
}
const tick = () => new Promise(resolve => setImmediate(resolve))
export const settle = async () => { for (let index = 0; index < 20; index += 1) await tick() }
export const plain = value => JSON.parse(JSON.stringify(value))
