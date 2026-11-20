import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: { contents: "export { SecretsPage } from './src/client/secret-card.js'; export { teamActions } from './src/client/team-actions.js'",
    resolveDir: fileURLToPath(new URL('../..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
})

export const visit = (node, matches) => {
  if (Array.isArray(node)) return node.flatMap(child => visit(child, matches))
  if (node === null || typeof node !== 'object') return []
  return [...(matches(node) ? [node] : []), ...visit(node.props.children, matches)]
}
export const text = node => Array.isArray(node) ? node.map(text).join('')
  : node === null || typeof node !== 'object' ? String(node ?? '') : text(node.props.children)
const tick = () => new Promise(resolve => setImmediate(resolve))

export function renderVaultSettings({ roster, actions, call, run, hostname = 'localhost', protocol = 'http:' }) {
  const module = { exports: {} }
  const slots = new Map()
  let mountedInputs = new Map()
  const effectQueue = []
  const scheduled = new Map()
  let timeout = 0
  let current
  const slot = initial => {
    const key = current.path + ':' + current.index++
    if (!slots.has(key)) slots.set(key, { value: initial })
    return slots.get(key)
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) { const s = slot(initial); return [s.value, value => { s.value = typeof value === 'function' ? value(s.value) : value }] },
    useRef(initial) { const s = slot({ current: initial }); return s.value },
    useId: () => slot('fixture-id').value,
    useEffect(run, deps) {
      const s = slot({})
      if (s.deps === undefined || deps.some((value, i) => !Object.is(value, s.deps[i]))) {
        effectQueue.push(() => { s.stop?.(); s.deps = deps; s.stop = run() })
      }
    },
    useLayoutEffect() {},
  }
  const location = { protocol, hostname }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    require: name => name === 'react' ? react : { MarkdownText: ({ text }) => text },
    document: { activeElement: null, querySelector: () => null, addEventListener() {}, removeEventListener() {} },
    location, URL, URLSearchParams, AbortController,
    setTimeout(run) { scheduled.set(++timeout, run); return timeout },
    clearTimeout(id) { scheduled.delete(id) },
  })
  const props = { roster, actions: actions ?? module.exports.teamActions({ call, after: promise => promise }), run,
    Section: ({ title, children }) => react.createElement('section', {}, title, ...children) }
  const paint = (node, path, inputs) => {
    if (Array.isArray(node)) return node.map((child, i) => paint(child, path + '/' + (child?.props?.key ?? i), inputs))
    if (node === null || typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      current = { path: path + '/' + node.type.name, index: 0 }
      return paint(node.type(node.props), current.path, inputs)
    }
    const ref = node.props.ref
    if (ref) {
      if (mountedInputs.get(ref) !== path) ref.current = { value: '' }
      inputs.set(ref, path)
    }
    return { ...node, props: { ...node.props, children: paint(node.props.children, path, inputs) } }
  }
  const render = () => {
    const inputs = new Map()
    const tree = paint(react.createElement(module.exports.SecretsPage, props), '', inputs)
    for (const ref of mountedInputs.keys()) if (!inputs.has(ref)) ref.current = null
    mountedInputs = inputs
    for (const effect of effectQueue.splice(0)) effect()
    return tree
  }
  const find = predicate => visit(render(), predicate)[0]
  const button = label => find(node => node.type === 'button' && text(node) === label)
  const input = label => find(node => node.props['aria-label'] === label)
  const fill = (label, value) => input(label).props.onChange({ target: { value } })
  const ready = async () => { render(); await tick(); render() }
  return { render, ready, button, input, fill, find }
}
