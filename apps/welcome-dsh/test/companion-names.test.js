import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { fakeLocale } from './fake-locale.js'

// Bundle the steps with their locale, as in team-i18n.test.js; effects never run.
const bundle = await build({
  stdin: {
    contents: [
      "export { CompanionStep } from './src/client/companion.js'",
      "export { TeamLede, joinedLabel } from './src/client/team.js'",
      "export { installLocale } from './src/client/i18n.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'], loader: { '.css': 'text' },
})
const client = { exports: {} }
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => [typeof initial === 'function' ? initial() : initial === undefined ? {} : initial, () => {}],
  useEffect: () => {}, useRef: current => ({ current }), useCallback: fn => fn, useMemo: fn => fn(),
}
runInNewContext(bundle.outputFiles[0].text, {
  module: client, exports: client.exports, URL, setTimeout, clearTimeout, document: { body: null },
  require: name => ({ react, 'react-dom': { createPortal: node => node } })[name],
})
const flow = client.exports
const locale = fakeLocale()
locale.addLanguage({ id: 'pt-BR', fallback: 'en' })
flow.installLocale(locale)

function render(node) {
  if (Array.isArray(node)) return node.map(render)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }))
  return { ...node, children: node.children.map(render) }
}
function findAll(node, match, out = []) {
  if (Array.isArray(node)) node.forEach(child => findAll(child, match, out))
  else if (node && typeof node === 'object') {
    if (match(node)) out.push(node)
    node.children.forEach(child => findAll(child, match, out))
  }
  return out
}

test('the companion offers Pirlim first and as its placeholder, without Pip among the ideas', () => {
  const tree = render(flow.CompanionStep({}))
  const names = findAll(tree, node => node.props.className === 'oai-chip').map(node => node.children.join(''))
  assert.deepEqual(names, ['Pirlim', 'Nova', 'Mochi', 'Echo', 'Biscuit'])
  assert.ok(!names.includes('Pip'))
  assert.equal(findAll(tree, node => node.type === 'input' && node.props.id === 'oai-name')[0].props.placeholder, 'Pirlim')
})

test('the committed client carries the Pirlim name ideas and no old Pip list', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /\bNAMES\s*=\s*\["Pirlim", "Nova", "Mochi", "Echo", "Biscuit"\]/)
  assert.doesNotMatch(source, /\["Pip", "Nova", "Mochi", "Echo", "Biscuit"\]/)
})

for (const language of ['en', 'pt-BR']) {
  test(`the team copy follows the companion's name in ${language}`, () => {
    locale.setLocale(language)
    try {
      for (const name of ['Pirlim', 'Nova']) {
        const lede = render(flow.TeamLede({ name }))
        assert.equal(lede.children[0], language === 'en' ? `${name} leads. Who comes along?` : `${name} lidera. Quem vem junto?`)
        assert.equal(flow.joinedLabel({ omni: false, genie: false }, name), language === 'en' ? `Continue with just ${name}` : `Continuar só com ${name}`)
      }
    } finally {
      locale.setLocale('en')
    }
  })
}
