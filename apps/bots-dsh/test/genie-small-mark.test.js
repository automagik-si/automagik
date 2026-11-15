// #1156: small Genie marks show the whole figure. The brand rule is "never crop to the head".
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const bundle = await build({
  stdin: {
    contents: "export { BotMark } from './src/client/mark.js'\n"
      + "export { SHELL_CSS } from './src/client/styles.js'\n"
      + "export { genieTint } from './src/client/genie-tint.js'",
    resolveDir: dirname(dirname(fileURLToPath(import.meta.url))),
  },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
const states = []
const sets = []
const react = {
  createElement: (type, props, ...children) => ({
    type, props: props ?? {}, children: children.flat(Infinity),
  }),
  useState: initial => [states.length > 0 ? states.shift() : initial, value => sets.push(value)],
  useEffect: () => {}, useRef: current => ({ current }),
  useLayoutEffect: () => {}, Fragment: 'fragment',
}
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, URLSearchParams,
  require: name => (name === 'react' ? react : {}),
})
const { BotMark: markOf, SHELL_CSS, genieTint } = module.exports
// A mark hands over to the mark that draws it (a pet, or the character itself): render through.
const BotMark = (props) => {
  let element = markOf(props)
  while (typeof element?.type === 'function') element = element.type(element.props)
  return element
}
const genie = { id: 'g', name: 'Genie', kind: 'genie' }
const rules = [...SHELL_CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]

for (const size of [14, 16, 22, 28]) {
  test(`a ${size} px Genie mark keeps its clay figure in the requested box`, () => {
    const mark = BotMark({ bot: genie, size })
    assert.equal(mark.props['data-shape'], 'clay-genie')
    assert.equal(mark.props.style.width, size)
    assert.equal(mark.props.style.height, size)
    assert.equal(mark.children[0].props.className, 'bt-b bt-clay bt-clay-genie')
  })
}

test('a 29 px Genie mark still wears its served pet', () => {
  const mark = BotMark({ bot: genie, size: 29 })
  assert.equal(mark.props['data-shape'], 'pet')
  assert.equal(mark.children[0].props.pet.sheet,
    'api/omni-ui/pet?source=builtin&id=genie-clay&v=2')
})

test('small Genie marks have no frame styles or clay cropping', () => {
  for (const [, selector, declarations] of rules) {
    assert.doesNotMatch(selector, /data-frame/)
    if (/bt-clay|data-frame/.test(selector)) {
      assert.doesNotMatch(declarations, /clip-path|mask-image/, selector)
    }
  }
})

test('the clay figure keeps its full height and Genie proportions', () => {
  const rule = selector => rules.find(([, found]) => found.trim() === selector)?.[2]
  assert.match(rule('.bt-clay-genie'), /(?:^|;)\s*aspect-ratio:\s*192\/208\s*(?:;|$)/)
  assert.match(rule('.bt-clay'), /(?:^|;)\s*height:\s*100%\s*(?:;|$)/)
})

test('a tinted 16 px Genie still passes its filter to the clay child', () => {
  const mark = BotMark({ bot: { ...genie, color: 'blue' }, size: 16 })
  const tint = genieTint('blue')
  assert.match(tint, /^hue-rotate\(-?\d+deg\)$/)
  assert.equal(mark.props['data-shape'], 'clay-genie')
  assert.equal(mark.children[0].props.className, 'bt-b bt-clay bt-clay-genie')
  assert.equal(mark.children[0].props.style.filter, tint)
})
