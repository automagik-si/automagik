import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const provider = 'proton-pass'
const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))
const { outputFiles } = await build({
  stdin: {
    contents: `export { SecretsPage, SecretCard } from './src/client/secret-card.js'
      export { installLocale } from './src/client/i18n.js'`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
})

const text = node => Array.isArray(node) ? node.map(text).join('')
  : node && typeof node === 'object' ? text(node.props.children) : String(node ?? '')
const walk = (node, match) => Array.isArray(node) ? node.flatMap(child => walk(child, match))
  : node && typeof node === 'object' ? [...(match(node) ? [node] : []), ...walk(node.props.children, match)] : []

function fixture() {
  const module = { exports: {} }
  const slots = new Map(), inputs = new Map()
  const effects = []
  let hook
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const slot = hook(previous => previous ?? { value: initial })
      return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
    },
    useRef: initial => hook(previous => previous ?? { current: initial }),
    useId: () => 'fixture-id',
    useLayoutEffect() {},
    useEffect(run, deps) {
      hook(previous => {
        if (previous && deps.every((value, index) => Object.is(value, previous.deps[index]))) return previous
        const next = { deps }
        effects.push(() => { previous?.stop?.(); next.stop = run() })
        return next
      })
    },
  }
  let poll
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    require: name => name === 'react' ? react : { MarkdownText: ({ text }) => text },
    document: { activeElement: null, querySelector: () => null, addEventListener() {}, removeEventListener() {} },
    location: { protocol: 'https:', hostname: 'localhost' }, URL, URLSearchParams, AbortController,
    setTimeout: callback => { poll = callback; return callback },
    clearTimeout: callback => { if (callback === poll) poll = undefined },
  })
  const { SecretsPage, SecretCard, installLocale } = module.exports
  installLocale({
    register() {},
    bind: () => (key, params = {}) => (pt[key] ?? key).replace(/\{(\w+)\}/g, (match, slot) => params[slot] ?? match),
  })
  const token = 'pst_' + randomBytes(32).toString('hex') + '::' + randomBytes(32).toString('base64url')
  const item = 'a'.repeat(86) + '==/' + 'b'.repeat(86) + '=='
  const selection = { id: item, name: 'Fixture item', vault: 'Fixture vault', fields: [
    { selector: 'number', label: 'Card number' }, { selector: 'verification_number', label: 'Security code' },
  ] }
  let state = 'locked'
  let items = [selection]
  const calls = []
  const roster = { byId: {}, bots: [], secretSourcesPresent: true, secretSources: { rows: [] } }
  const actions = {
    async vaultStatus(_signal, choice = 'bitwarden') {
      return { provider: choice, providers: ['bitwarden', provider], connection: choice, state }
    },
    async vaultTokenSet(choice, value, connection) {
      calls.push(['set', choice, connection, value === token])
      state = 'unlocked'
    },
    async vaultLock(choice) { calls.push(['lock', choice]); state = 'locked' },
    async vaultItems(query, choice) { calls.push(['items', query, choice]); return { items } },
    async secretSourceSet(mapping) { calls.push(['mapping', mapping.provider, mapping.connection, mapping.field, mapping.item === item]) },
    async secretSourceDetail() { return { commandDigest: 'digest', snapshot: 'snapshot', provider, item, field: 'number' } },
  }
  const props = { roster, actions, run: async promise => { await promise; return true },
    Section: ({ title, children }) => react.createElement('section', {}, title, ...children) }
  const paint = (node, path) => {
    if (Array.isArray(node)) return node.map((child, index) => paint(child, path + '/' + index))
    if (!node || typeof node !== 'object') return node
    path += '/' + (node.props.key ?? (typeof node.type === 'function' ? node.type.name : node.type))
    if (typeof node.type === 'function') {
      const list = slots.get(path) ?? []
      slots.set(path, list)
      let index = 0
      hook = build => {
        const at = index++
        return list[at] = build(list[at])
      }
      return paint(node.type(node.props), path)
    }
    if (node.props.ref) {
      if (!inputs.has(path)) inputs.set(path, { value: '' })
      node.props.ref.current = inputs.get(path)
    }
    return { ...node, props: { ...node.props, children: paint(node.props.children, path) } }
  }
  const render = (component = SecretsPage, input = props) => {
    const tree = paint(react.createElement(component, input), '')
    for (const effect of effects.splice(0)) effect()
    assert.equal(text(tree).includes(token), false)
    return tree
  }
  const ready = async () => { render(); await setImmediate(); return render() }
  const find = match => walk(render(), match)[0]
  const label = key => find(node => node.props['aria-label'] === (pt[key] ?? key))
  const button = key => find(node => node.type === 'button' && text(node) === (pt[key] ?? key))
  const fill = (key, value) => label(key).props.onChange({ target: { value } })
  return {
    ready, render, find, label, button, fill, calls, item, empty: () => { items = [] },
    enter() {
      const input = label('Proton Pass personal access token').props
      assert.equal(input.type, 'password')
      assert.equal(input.value, undefined)
      input.ref.current.value = token
      return input.ref.current
    },
    async card() {
      const input = { sessionId: 'fixture', bot: { id: 'fixture', name: 'Bot' }, roster, actions,
        request: { id: 'req', sessionId: 'fixture', name: 'KEY', source: 'vault', commandDigest: 'digest',
          shell: 'bash', workdir: '/fixture', command: 'fixture-command' } }
      render(SecretCard, input)
      await setImmediate()
      return render(SecretCard, input)
    },
  }
}

test('Proton Settings use translated controls, grouped items and fixed field labels', async () => {
  const h = fixture()
  await h.ready()
  h.fill('Vault provider', provider)
  assert.match(text(await h.ready()), /leitura a um cofre.*110 minutos/)
  const tokenInput = h.enter()
  await h.button('Set token').props.onClick()
  assert.equal(tokenInput.value === '', true)
  await h.ready()
  const replacement = h.enter()
  await h.button('Replace token').props.onClick()
  assert.equal(replacement.value === '', true)
  await h.ready()
  h.button('Add a vault key').props.onClick()
  h.fill('Key name', 'fixture-key')
  h.fill('Search the vault', 'Fixture')
  const search = () => h.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  await search()
  assert.equal(h.find(node => node.type === 'optgroup').props.label, 'Fixture vault')
  h.fill('Vault item', h.item)
  assert.match(text(h.render()), /Número do cartão.*Código de segurança/)
  h.fill('Vault field', 'number')
  await h.button('Save key').props.onClick()
  h.button('Add a vault key').props.onClick()
  h.empty()
  await search()
  assert.match(text(h.render()), /Nenhum item correspondente no cofre/)
  assert.equal(h.button('Clear token'), undefined)
  await h.button('Lock').props.onClick()
  await h.ready()
  assert.equal(h.button('Add a vault key'), undefined)
  assert.deepEqual(h.calls, [['set', provider, provider, true], ['set', provider, provider, true],
    ['items', 'Fixture', provider], ['mapping', provider, provider, 'number', true], ['items', 'Fixture', provider],
    ['lock', provider]])
})

test('Proton approval card shows the provider name', async () => {
  const card = await fixture().card()
  assert.match(text(card), /Proton Pass/)
  assert.equal(text(card).includes(provider), false)
})

test('every Proton picker field and Settings hint has a pt-BR translation', () => {
  for (const label of ['Username', 'Email', 'Password', 'Note', 'Cardholder name', 'Card number',
    'Security code', 'Expiration date', 'PIN', 'Wi-Fi name', 'Private key',
    'Proton Pass personal access token']) {
    assert.equal(typeof pt[label], 'string', label)
    assert.ok(pt[label].length > 0, label)
  }
  const hint = 'The token is used once to sign in and needs read access to a vault; items shared on their own are not listed. The session ends when the vault locks, after at most 110 minutes, or when the app quits.'
  assert.match(pt[hint], /110 minutos/)
})
