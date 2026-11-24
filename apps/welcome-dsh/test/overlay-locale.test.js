// #391: the welcome overlay reads its copy through DSH's locale service. The client boot starts
// plugin entries together, so the welcome declares the service and the shell parks it until a
// locale exists; a pt-BR page then renders the overlay in Portuguese, and a key the dictionary
// does not carry still reads in English. The slot components rendered here are the ones the
// plugin registers on DSH's onboarding slot, so the test reads the overlay's own strings.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import { fakeLocale } from './fake-locale.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))

// The client entry and the copy it installs in one bundle: `apply` is the real one, and `t` is
// the same module instance's lookup. client-bundle.test.js pins the committed client.js to it.
const bundle = await build({
  stdin: {
    contents: [
      "export { apply, inject } from './src/client/index.js'",
      "export { NAMESPACE, PT_BR, t } from './src/client/i18n.js'",
    ].join('\n'),
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  // The Bot team's client stays external, as in client.js (scripts/build-client.mjs).
  external: ['react', 'react-dom', '@automagik/bots-dsh/client'],
  loader: { '.css': 'text' },
})
const module = { exports: {} }
// A React that renders once: hooks hand back their initial value, and effects never run. The
// step gate's undecided state (useState(undefined)) reads as a host state with no flags, so a
// step draws itself, as in the other step tests.
const react = {
  createElement: (type, props, ...children) => ({
    type, props: props ?? {}, children: children.flat(Infinity),
  }),
  useState: initial => [
    typeof initial === 'function' ? initial() : initial === undefined ? {} : initial, () => {},
  ],
  useEffect: () => {}, useRef: current => ({ current }), useCallback: fn => fn, useMemo: fn => fn(),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}
const doc = {
  documentElement: { lang: 'en' },
  createElement: () => ({
    dataset: {}, setAttribute() {}, append() {}, classList: { add() {}, remove() {} }, remove() {},
  }),
  head: { append() {} },
  body: { append() {}, querySelector: () => null },
  getElementById: () => null,
  querySelector: () => null,
}
runInNewContext(bundle.outputFiles[0].text, {
  module,
  exports: module.exports,
  URL,
  setTimeout,
  clearTimeout,
  document: doc,
  console,
  require: name => ({ react, 'react-dom': { createPortal: node => node } })[name],
})
const welcome = module.exports

// The two slots the onboarding overlay asks for: settings.onboarding entries, registered when
// the shell declares the slot. The real slot service does the same and re-renders on a locale
// change; the test calls the components itself.
function fakeSlots() {
  const registered = []
  return {
    registered,
    inject(name, register) {
      register()
      return () => {}
    },
    register(options, component) {
      registered.push({ ...options, component })
      return () => {}
    },
  }
}

function render(node) {
  if (Array.isArray(node)) return node.map(render)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    return render(node.type({ ...node.props, children: node.children }))
  }
  return { ...node, children: (node.children ?? []).map(render) }
}
function findAll(node, match, out = []) {
  if (Array.isArray(node)) node.forEach(child => findAll(child, match, out))
  else if (node && typeof node === 'object') {
    if (match(node)) out.push(node)
    node.children.forEach(child => findAll(child, match, out))
  }
  return out
}
const textOf = (node) => {
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object') return textOf(node.children)
  return node === null || node === undefined || node === false ? '' : String(node)
}
const byType = type => node => node.type === type
const byClass = name => node => String(node?.props?.className ?? '').split(' ').includes(name)
const step = (slots, id) => slots.registered.find(entry => entry.id === id)
const title = slots => textOf(findAll(render(step(slots, 'omni-companion').component({
  stepId: 'omni-companion', complete: () => {},
})), byType('h1'))[0])
const rule = slots => textOf(findAll(render(step(slots, 'omni-team').component({
  stepId: 'omni-team', complete: () => {}, openSection: () => {},
})), byClass('oai-lede-rule'))[0])

test('the welcome overlay follows the page locale, #318 line included', async () => {
  const ctx = new Context()
  const slots = fakeSlots()
  ctx.provide('slots', slots)
  const activated = ctx.plugin({ inject: [...welcome.inject], apply: welcome.apply })
  try {
    await Promise.resolve()
    // No locale yet: the shell parks the welcome instead of drawing an English overlay.
    assert.deepEqual(Array.from(welcome.inject), ['slots', 'locale'])
    assert.deepEqual(slots.registered, [])

    const locale = fakeLocale()
    ctx.provide('locale', locale)
    await activated
    assert.deepEqual(locale.calls, [['welcome.team', ['en', 'pt', 'pt-BR', 'zh']]])

    // The page is still English, and the overlay reads the same service.
    assert.equal(title(slots), 'Create your companion')
    assert.equal(rule(slots), 'Code work goes to a Bot with Computer.')

    // A pt-BR page: the onboarding steps re-read the dictionary, #318's line included.
    locale.addLanguage({ id: 'pt-BR', label: 'Português (Brasil)', fallback: 'en' })
    locale.setLocale('pt-BR')
    assert.equal(title(slots), 'Crie sua companhia')
    assert.equal(rule(slots), 'Trabalho de código vai para um Bot com Computador.')

    // A key the Portuguese dictionary does not carry still reads in English.
    assert.equal(welcome.t('A key with no Portuguese text'), 'A key with no Portuguese text')
  } finally {
    await ctx.fiber.dispose()
  }
})
