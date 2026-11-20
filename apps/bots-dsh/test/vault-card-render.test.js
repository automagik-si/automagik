import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: `
      export { SecretToolCell, SecretsPage } from './src/client/secret-card.js'
      export { teamActions } from './src/client/team-actions.js'
    `,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
let hook
const effect = (setup, deps) => hook(previous => {
  if (previous && deps.length === previous.deps.length && deps.every((value, index) => Object.is(value, previous.deps[index]))) return previous
  previous?.cleanup?.()
  return { deps, cleanup: setup() }
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState: initial => {
    const slot = hook(previous => previous ?? { value: typeof initial === 'function' ? initial() : initial })
    return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
  },
  useRef: initial => hook(previous => previous ?? { current: initial }),
  useId: () => 'fixture-id',
  useEffect: effect,
  useLayoutEffect: effect,
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
}
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => name === 'react' ? react : { MarkdownText: ({ text }) => text },
  document: { activeElement: null, querySelector: () => null, addEventListener() {}, removeEventListener() {} },
  location: { protocol: 'http:', hostname: 'localhost' },
  HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {}, HTMLElement: class {},
  URL, URLSearchParams,
})
const { SecretToolCell, SecretsPage, teamActions } = module.exports

function renderer(root) {
  const slots = new Map()
  function render(node, path, seen) {
    if (Array.isArray(node)) return node.map((child, index) => render(child, `${path}/${child?.props?.key ?? index}`, seen))
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      const key = `${path}:${node.type.name}:${node.props.key ?? ''}`
      seen.add(key)
      const list = slots.get(key) ?? []
      slots.set(key, list)
      let index = 0
      hook = build => {
        const current = index++
        list[current] = build(list[current])
        return list[current]
      }
      return render(node.type(node.props), key, seen)
    }
    return { ...node, props: { ...node.props, children: render(node.props.children, path, seen) } }
  }
  return () => {
    const seen = new Set()
    const tree = render(root(), '', seen)
    for (const [key, list] of slots) {
      if (seen.has(key)) continue
      for (const slot of list) slot?.cleanup?.()
      slots.delete(key)
    }
    return tree
  }
}

function contents(node) {
  if (Array.isArray(node)) return node.map(contents).join('')
  if (!node || typeof node !== 'object') return node == null || node === false ? '' : String(node)
  return contents(node.props.children)
}
function find(node, match) {
  if (Array.isArray(node)) return node.flatMap(child => find(child, match))
  if (!node || typeof node !== 'object') return []
  return [...(match(node) ? [node] : []), ...find(node.props.children, match)]
}
const button = (tree, label) => find(tree, node => node.type === 'button' && contents(node) === label)[0]

const bot = { id: 'fixture-member', sessionId: 'fixture-chat', name: 'Member Fixture' }
const card = {
  id: 'fixture-request', callId: 'fixture-call', sessionId: bot.sessionId,
  name: 'VAULT_FIXTURE', purpose: 'Use the fixture', source: 'vault',
  shell: 'bash', workdir: '/fixture/folder with spaces', command: '\n  fixture <literal>\n  fixture "two words"\n',
  commandDigest: 'a'.repeat(64), kind: 'allow', status: 'pending',
}
const details = {
  provider: 'fixture-provider', item: 'fixture-item', field: 'fixture-field',
  commandDigest: card.commandDigest, snapshot: 'fixture-snapshot',
}
const rosterFor = request => ({ byId: { [bot.sessionId]: bot }, bots: [bot], secrets: [], secretRequests: { [bot.id]: [request] } })

function fixture(request = { ...card }) {
  const calls = []
  const response = Promise.withResolvers()
  const roster = rosterFor(request)
  const actions = teamActions({
    after: promise => promise,
    call: (endpoint, payload) => {
      calls.push([endpoint, { ...payload }])
      return endpoint === 'secret-source-detail' ? response.promise : Promise.resolve(true)
    },
  })
  const render = renderer(() => react.createElement(SecretToolCell, {
    sessionId: bot.sessionId, callId: card.callId, roster, actions,
  }))
  return { request, roster, render, calls, response }
}

test('vault Allow waits for the private detail and submits the returned digest and snapshot', async () => {
  const h = fixture()
  let tree = h.render()
  assert.equal(button(tree, 'Allow').props.disabled, true)
  assert.ok(button(tree, 'Cancel'))
  assert.equal(find(tree, node => node.type === 'input').length, 0)
  assert.equal(button(tree, 'Replace value'), undefined)
  assert.match(contents(tree), /VAULT_FIXTURE.*Use the fixture.*From a vault.*Shell: bash.*Folder: \/fixture\/folder with spaces/)
  const [pre] = find(tree, node => node.type === 'pre')
  assert.equal(contents(pre), card.command)
  h.render()
  await setImmediate()
  assert.deepEqual(h.calls, [['secret-source-detail', { requestId: card.id }]])
  h.response.resolve(details)
  await setImmediate()
  tree = h.render()
  assert.match(contents(tree), /Provider: fixture-providerItem: fixture-itemField: fixture-field/)
  assert.doesNotMatch(JSON.stringify(h.roster), /fixture-provider|fixture-item|fixture-field|fixture-snapshot/)
  assert.equal(button(tree, 'Allow').props.disabled, false)
  button(tree, 'Allow').props.onClick()
  await setImmediate()
  assert.deepEqual(h.calls.slice(1), [
    ['secret-allow', { requestId: card.id, commandDigest: details.commandDigest, snapshot: details.snapshot }],
  ])
})

test('missing or mismatched detail leaves Allow disabled and Cancel working', async () => {
  for (const settle of [
    response => response.reject(new Error('fixture detail failure')),
    response => response.resolve({ ...details, commandDigest: 'b'.repeat(64) }),
    response => response.resolve({ ...details, snapshot: undefined }),
  ]) {
    const h = fixture()
    h.render()
    await setImmediate()
    settle(h.response)
    await setImmediate()
    const tree = h.render()
    assert.equal(button(tree, 'Allow').props.disabled, true)
    assert.match(contents(tree), /vault item details could not be loaded/)
    button(tree, 'Allow').props.onClick()
    await button(tree, 'Cancel').props.onClick()
    assert.deepEqual(h.calls.map(([endpoint]) => endpoint), ['secret-source-detail', 'secret-cancel'])
  }
})

test('a changed rendered command invalidates an already loaded detail', async () => {
  const h = fixture()
  h.render()
  h.response.resolve(details)
  await setImmediate()
  assert.equal(button(h.render(), 'Allow').props.disabled, false)
  h.request.command = 'edited fixture'
  assert.equal(button(h.render(), 'Allow').props.disabled, true)
  await setImmediate()
  assert.deepEqual(h.calls, [['secret-source-detail', { requestId: card.id }]])
  assert.equal(button(h.render(), 'Allow').props.disabled, true)
})

test('locked and settled vault cards show their outcome without detail fetches or typed controls', async () => {
  for (const [status, expected] of [
    ['locked', /The vault is locked\. Unlock it in Settings › Vault and ask again; nothing was read\./],
    ['allowed', /Allowed once/],
    ['canceled', /Canceled/],
  ]) {
    const h = fixture({ ...card, status, scope: 'all' })
    const tree = h.render()
    assert.match(contents(tree), expected)
    assert.match(contents(tree), /From a vault/)
    assert.doesNotMatch(contents(tree), /All Bots|Replace value|fixture-item/)
    assert.equal(find(tree, node => node.type === 'button' || node.type === 'input').length, 0)
    await setImmediate()
    assert.deepEqual(h.calls, [])
  }
})

test('typed Allow keeps its original payload and replace option', async () => {
  const h = fixture({ ...card, source: undefined })
  const tree = h.render()
  assert.ok(button(tree, 'Replace value'))
  button(tree, 'Allow').props.onClick()
  await setImmediate()
  assert.deepEqual(h.calls, [['secret-allow', { requestId: card.id }]])
})

test('the mapped-only settings hint follows service presence without overriding the dual hint', () => {
  const roster = {
    ...rosterFor(card),
    secretSourcesPresent: true,
    secretSources: { rows: [
      { name: 'VAULT_FIXTURE', purpose: 'Mapped fixture' },
      { name: 'DUAL_FIXTURE', definedTwice: true },
    ] },
  }
  const Section = ({ title, children }) => react.createElement('section', {}, title, ...children)
  const render = renderer(() => react.createElement(SecretsPage, { roster, actions: {}, Section }))
  assert.match(contents(render()), /Each use asks you first, in the Bot's chat\./)
  assert.match(contents(render()), /DUAL_FIXTUREDefined twice/)
  roster.secretSourcesPresent = false
  assert.match(contents(render()), /Unavailable: the vault plugin cannot serve it yet/)
})

test('shipped vault copy includes both translations and documents the one-command limit', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
  const zhSource = read('../src/client/i18n.js')
  const zhBundle = read('../client.js')
  const ptSource = JSON.parse(read('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json'))
  const ptBundle = read('../../locale-pt-br-dsh/client.js')
  for (const key of ['From a vault', 'Allowed once', 'The vault is locked. Unlock it in Settings › Vault and ask again; nothing was read.',
    'Shell: {shell}', 'Folder: {folder}', "Each use asks you first, in the Bot's chat."]) {
    assert.ok(zhSource.includes(key), `missing Chinese source key: ${key}`)
    assert.ok(zhBundle.includes(key), `missing Chinese bundle key: ${key}`)
    assert.equal(typeof ptSource[key], 'string', `missing Portuguese source key: ${key}`)
    assert.ok(ptBundle.includes(ptSource[key]), `missing Portuguese bundle text: ${key}`)
  }
  const readme = read('../README.md')
  assert.match(readme, /Each approval covers one attempt at the exact command, in the shell and folder shown on the card\./)
  assert.match(readme, /Vault values cannot reach a shell in this version\./)
})
