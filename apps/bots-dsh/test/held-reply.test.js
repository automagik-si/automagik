import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { HELD_NOT_SET } from '../src/shared/held.js'

const bundle = await build({
  stdin: { contents: "export { AssistantCell } from './cells.js'; export { installLocale } from './i18n.js'", resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
function MarkdownText() { return null }
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, AbortController, fetch,
  require: (name) => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [initial, () => {}], useEffect: () => {}, useRef: current => ({ current }),
        useLayoutEffect: () => {}, useMemo: make => make(), Fragment: 'fragment',
        // The bundled Deep View widgets make a React context when their module loads.
        createContext: value => ({ Provider: 'Provider', value }), useContext: context => context.value,
      },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { AssistantCell, installLocale } = module.exports

// Renders the named components of an element tree, leaving the rest as elements.
const expand = (node, names) => {
  if (Array.isArray(node)) return node.flatMap(child => expand(child, names))
  if (node === null || typeof node !== 'object') return node
  if (names.includes(node.type?.name)) return expand(node.type({ ...node.props, children: node.children }), names)
  return { ...node, children: node.children.map(child => expand(child, names)) }
}
const find = (node, match) => {
  if (Array.isArray(node)) return node.flatMap(child => find(child, match))
  if (node === null || typeof node !== 'object') return []
  return [...(match(node) ? [node] : []), ...find(node.children, match)]
}
const roster = { bots: [], byId: { ada: { id: 'ada', name: 'ada' } }, roomsById: {}, exchangeTurns: {} }
const finished = { turn: 3, status: 'closed', end: { time: 2_000 } }
function cellProps({ closingSeq = 10, turn = finished } = {}) {
  const asked = []
  const links = { resolve: () => undefined }
  const props = {
    node: {
      key: 'n10',
      location: { kind: 'step', turn },
      data: { turn: 3, step: 1, seq: 10, status: 'done', finalNode: { seq: 10 }, blocks: [{ kind: 'text', text: 'x' }] },
    },
    sessionId: 'ada',
    openFile: () => {},
    fileMentions: (owner) => { asked.push(owner); return links },
    useTurnData: key => (key === 'turn-tail' ? { closing: { finalNode: { seq: closingSeq } } } : undefined),
    useRoster: select => select(roster),
    useUi: () => null,
    useTurnSteps: () => [],
    useTurnContext: () => [],
    actions: { noteLive() {} },
  }
  return { props, asked, links }
}
const markdownOf = props => find(expand(AssistantCell(props), ['Bubbles', 'Bubble']), node => node.type === MarkdownText)

function fakeLocale(active) {
  const dicts = new Map()
  return {
    register: (ns, locale, dict) => { dicts.set(`${ns}:${locale}`, dict); return () => dicts.delete(`${ns}:${locale}`) },
    bind: ns => (key, params) => {
      const text = (active === 'zh' ? dicts.get(`${ns}:zh`)?.[key] : undefined) ?? key
      return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text
    },
    getLocale: () => ({ active }),
  }
}

test('AssistantCell renders held turns in the interface language and leaves other replies alone', () => {
  const off = installLocale(fakeLocale('zh'))
  try {
    for (const [text, expected] of [
      [HELD_NOT_SET, '无法为这个对话设置权限级别，所以代理没有在这里运行。重启 DeepSeek Harness 或更改权限级别会再试一次。'],
      ['Model', 'Model'], ['x', 'x'], [HELD_NOT_SET + ' x', HELD_NOT_SET + ' x'],
    ]) {
      const { props } = cellProps()
      props.node.data.blocks = [{ kind: 'text', text }]
      const rendered = markdownOf(props)
      assert.equal(rendered.length, 1)
      assert.equal(rendered[0].props.text, expected)
    }
  } finally { off() }
})
