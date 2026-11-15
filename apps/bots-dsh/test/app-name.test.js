// The app is Automagik; Omni is one of its Bots (#1160). The way back from classic Agent mode
// carries the app's mark, so the name beside it is the app's, and a recorded problem that came
// from the plugin's own host names the app too.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { DICTIONARY } from '../src/client/i18n.js'

const bundle = await build({
  stdin: { contents: "export { BotReturn } from './src/client/sidebar.js'\nexport { sourceName } from './src/client/feedback.js'\nexport { OmniMark } from './src/client/logo.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id', useCallback: fn => fn,
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
}
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, URL, URLSearchParams, setTimeout, clearTimeout,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
  window: { innerWidth: 1280, matchMedia: () => ({ matches: false }) },
  document: { body: { dataset: {} } },
  matchMedia: () => ({ matches: false }),
})
const { BotReturn, sourceName, OmniMark } = module.exports

const texts = node => (Array.isArray(node) ? node.flatMap(texts) : typeof node === 'string' ? [node] : node && typeof node === 'object' ? texts(node.props?.children) : [])
const button = (wide, mode = 'agent', went = []) => BotReturn({ wide, useSurface: pick => pick({ mode }), actions: { setSurface: surface => went.push(surface) } })

test('the way back from classic Agent mode says Automagik beside the mark', () => {
  const went = []
  const back = button(true, 'agent', went)
  assert.equal(back.type, 'button')
  assert.equal(back.props.className, 'bt-return')
  assert.deepEqual(texts(back), ['Automagik'], 'the one word on the button is the app\'s name')
  assert.equal(back.props['aria-label'], 'Back to Automagik')
  assert.equal(back.props.title, 'Back to Automagik')
  assert.equal(back.props.children[0].type, OmniMark, 'the mark stays first')
  back.props.onClick()
  assert.deepEqual(went, ['bot'], 'it still goes back to the Bot team')
})

test('on the narrow rail the button is the mark alone, and still says where it goes', () => {
  const back = button(false)
  assert.deepEqual(texts(back), [])
  assert.equal(back.props['aria-label'], 'Back to Automagik')
  assert.equal(back.props.title, 'Back to Automagik')
})

test('nothing on the way back calls the app Omni', () => {
  for (const wide of [true, false]) {
    const back = button(wide)
    for (const said of [...texts(back), back.props['aria-label'], back.props.title]) assert.doesNotMatch(said, /Omni/)
  }
})

test('outside Agent mode there is no way back to draw', () => {
  assert.equal(button(true, 'bot'), null)
})

test('the way back has a Chinese label', () => {
  assert.equal(DICTIONARY.zh['Back to Automagik'], '返回 Automagik')
  assert.equal(DICTIONARY.zh.Automagik, 'Automagik')
})

test('a problem recorded by the plugin\'s own host is Automagik\'s, not Omni\'s', () => {
  assert.equal(sourceName('host'), 'Automagik')
  assert.equal(sourceName('api'), 'Automagik')
  assert.equal(sourceName(undefined), 'Automagik', 'an entry without a source is the app\'s too')
  assert.equal(sourceName('turn'), 'Model call')
  assert.equal(sourceName('browser'), 'This window')
})
