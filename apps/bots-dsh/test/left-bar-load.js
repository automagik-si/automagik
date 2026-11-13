// Loads the new left bar's parts (src/client/left-bar-*.js) for the left-bar tests: bundled once
// with esbuild and run with a React stand-in whose elements are plain objects, so a test reads
// what a part draws without a DOM. `render` expands function components down to the tags.
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))

const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/client/left-bar-status.js'",
      "export * from './src/client/left-bar-team.js'",
      "export * from './src/client/left-bar-rail.js'",
      "export * from './src/client/left-bar-faces.js'",
      "export * from './src/client/left-bar-css.js'",
      "export { installLocale } from './src/client/i18n.js'",
    ].join('\n'),
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useMemo: make => make(), useRef: current => ({ current }), Fragment: 'fragment',
}
const module = { exports: {} }
// Run in this realm, so the arrays and objects the parts return compare deeply with a test's own.
new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(module, module.exports, name => (name === 'react' ? react : {}))
export const parts = module.exports

/** An element with its function components drawn, down to tags and text. */
export function render(element) {
  if (element === null || element === undefined || element === false) return null
  if (typeof element !== 'object') return element
  if (Array.isArray(element)) return element.map(render).filter(child => child !== null)
  if (typeof element.type === 'function') return render(element.type({ ...element.props, children: element.children }))
  return { type: element.type, props: element.props, children: element.children.map(render).filter(child => child !== null) }
}

/** Every element under `node` (itself included) that `match` accepts. */
export function findAll(node, match) {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(child => findAll(child, match))
  return [...(match(node) ? [node] : []), ...node.children.flatMap(child => findAll(child, match))]
}

export const hasClass = name => node => String(node.props?.className ?? '').split(' ').includes(name)

/** The text a node shows, its children's in order. */
export const textOf = node => (node === null || node === undefined ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(textOf).join('') : node.children.map(textOf).join(''))
