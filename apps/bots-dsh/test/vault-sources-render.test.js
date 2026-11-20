import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { SecretsPage } from './src/client/secret-card.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
let useState
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState: initial => useState(initial),
  useRef: initial => ({ current: initial }),
  useId: () => 'row-id',
  useEffect: () => {}, useLayoutEffect: () => {},
  useSyncExternalStore: (subscribe, snapshot) => snapshot(),
}
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => name === 'react' ? react : { MarkdownText: ({ text }) => text },
  document: { activeElement: null, querySelector: () => null, addEventListener() {}, removeEventListener() {} },
  location: { protocol: 'http:', hostname: 'localhost' },
  HTMLInputElement: class {}, HTMLTextAreaElement: class {},
  HTMLSelectElement: class {}, HTMLElement: class {},
  URL, URLSearchParams,
})
const { SecretsPage } = module.exports

function fixture({ rows, secrets = [], broken = false }) {
  const calls = []
  const states = new Map()
  const Section = ({ title, children }) => react.createElement('section', {}, title, ...children)
  const props = {
    roster: { byId: {}, bots: [], secrets, secretSources: { rows, broken } },
    Section,
    actions: {
      secretSourceClear: name => { calls.push(['clear', name]); return Promise.resolve() },
      secretDelete: name => { calls.push(['delete', name]); return Promise.resolve() },
    },
    run: async promise => { await promise; return true },
  }
  function render(node = react.createElement(SecretsPage, props), path = '') {
    if (Array.isArray(node)) return node.map((child, i) => render(child, `${path}/${child?.props?.key ?? i}`))
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      let index = 0
      useState = initial => {
        const key = `${path}/${node.type.name}:${index++}`
        if (!states.has(key)) states.set(key, initial)
        return [states.get(key), next => states.set(key, next)]
      }
      return render(node.type(node.props), path)
    }
    return { ...node, props: { ...node.props, children: render(node.props.children, path) } }
  }
  const click = label => {
    const button = nodes(render(), child => child.type === 'button' && text(child).includes(label))[0]
    assert.ok(button, `button labeled ${label}`)
    return button.props.onClick()
  }
  return { render, click, calls }
}

function text(node) {
  if (Array.isArray(node)) return node.map(text).join('')
  if (!node || typeof node !== 'object') return node == null || node === false ? '' : String(node)
  return text(node.props.children)
}
function nodes(node, match) {
  if (Array.isArray(node)) return node.flatMap(child => nodes(child, match))
  if (!node || typeof node !== 'object') return []
  return [...(match(node) ? [node] : []), ...nodes(node.props.children, match)]
}

const name = 'FIXTURE_KEY'
const source = { name, purpose: 'Vault purpose', scope: 'all', definedTwice: false }

test('a dual source shows both recovery actions with a stale or duplicated typed roster', async () => {
  for (const secrets of [[], [{ name, scope: 'all', purpose: 'Stale purpose', lastUsedAt: 1000 }]]) {
    const h = fixture({ secrets, rows: [{ ...source, definedTwice: true }] })
    const summary = text(h.render())
    assert.match(summary, /Secrets · 1/)
    assert.match(summary, /FIXTURE_KEYVault purposeDefined twice/)
    assert.doesNotMatch(summary, /last used|Stale purpose/)
    assert.equal(nodes(h.render(), node => node.props.className === 'bt-secret-item').length, 1)

    h.click(name)
    assert.match(text(h.render()), /Defined twice: this name is also mapped to a vault item, so no Bot can use it. Delete one of them./)
    assert.match(text(h.render()), /Remove the vault mapping/)
    assert.match(text(h.render()), /Delete the typed key/)
    assert.doesNotMatch(text(h.render()), /Replace the value/)
    h.click('Remove the vault mapping')
    assert.match(text(h.render()), /Remove the mapping for FIXTURE_KEY\?/)
    await h.click('Remove the mapping')
    h.click('Delete the typed key')
    await h.click('Delete')
    assert.deepEqual(h.calls, [['clear', name], ['delete', name]])
  }
})

test('a mapped-only row shows its unavailable hint and confirms removal', async () => {
  const h = fixture({ rows: [source] })
  const shown = text(h.render())
  assert.match(shown, /FIXTURE_KEYVault purposeUnavailable: the vault plugin cannot serve it yet/)
  assert.match(shown, /From a vault/)
  h.click(name)
  assert.doesNotMatch(text(h.render()), /Delete the typed key/)
  h.click('Remove the mapping')
  assert.match(text(h.render()), /Remove the mapping for FIXTURE_KEY\?/)
  assert.deepEqual(h.calls, [])
  h.click('Keep')
  h.click('Remove the mapping')
  await h.click('Remove the mapping')
  assert.deepEqual(h.calls, [['clear', name]])
})

test('a broken mapping shows one warning before the list', () => {
  const h = fixture({ broken: true, rows: [], secrets: [{ name, scope: 'all', createdAt: 0 }] })
  const rendered = h.render()
  const notes = nodes(rendered, node => node.props.className === 'bt-secret-warn')
  assert.equal(notes.length, 1)
  assert.equal(text(notes[0]), 'The vault mapping file could not be read; no secret can be used until it is fixed.')
  assert.ok(text(rendered).indexOf(text(notes[0])) < text(rendered).indexOf(name))
})
