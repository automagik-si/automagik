import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: { contents: "export { SecretsPage } from './src/client/secret-card.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
})

const walk = (node, predicate) => {
  if (Array.isArray(node)) return node.flatMap(child => walk(child, predicate))
  if (!node || typeof node !== 'object') return []
  return [...(predicate(node) ? [node] : []), ...walk(node.props.children, predicate)]
}
const text = node => Array.isArray(node) ? node.map(text).join('')
  : typeof node === 'object' && node !== null ? text(node.props.children) : String(node ?? '')
const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture({ hostname = 'localhost', mapped = false, cloud = false } = {}) {
  const module = { exports: {} }
  const slots = new Map()
  const inputs = new Map()
  const effects = []
  let current
  let poll
  let polledPair
  let onePassword = 'locked'
  let acceptsToken = false
  const token = randomBytes(24).toString('hex')
  const calls = []
  const id = () => randomBytes(13).toString('hex')
  const item = id() + '/' + id()
  const sectionField = id() + '/' + id()
  const slot = value => {
    const key = current.path + ':' + current.index++
    if (!slots.has(key)) slots.set(key, { value })
    return slots.get(key)
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(value) {
      const state = slot(value)
      return [state.value, next => { state.value = typeof next === 'function' ? next(state.value) : next }]
    },
    useRef(value) { return slot({ current: value }).value },
    useId: () => slot('fixture-id').value,
    useEffect(run, deps) {
      const state = slot(undefined)
      if (state.deps !== undefined && deps.every((value, index) => Object.is(value, state.deps[index]))) return
      effects.push(() => { state.stop?.(); state.deps = deps; state.stop = run() })
    },
    useLayoutEffect() {},
  }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    require: name => name === 'react' ? react : { MarkdownText: ({ text }) => text },
    document: { activeElement: null, querySelector: () => null, addEventListener() {}, removeEventListener() {} },
    location: { protocol: 'https:', hostname }, URL, URLSearchParams, AbortController,
    setTimeout: callback => { poll = callback; return callback },
    clearTimeout: callback => { if (poll === callback) poll = undefined },
  })
  const roster = { byId: {}, bots: [], secretSourcesPresent: true,
    secretSources: { rows: mapped ? [{ name: 'SERVICE_KEY' }] : [] } }
  const actions = {
    async vaultStatus(_signal, choice) {
      const provider = polledPair?.provider ?? (mapped ? 'onepassword' : choice ?? 'bitwarden')
      return { provider, providers: ['bitwarden', 'onepassword'], connection: polledPair?.connection ?? provider,
        state: provider === 'bitwarden' ? 'locked' : cloud ? 'unavailable' : onePassword,
        ...(cloud && provider === 'onepassword' ? { reason: '1Password is unavailable in Automagik Cloud.' } : {}) }
    },
    async vaultTokenSet(provider, value, connection) {
      credentialPairs.push([provider, connection])
      calls.push(['set', provider, value === token])
      if (!acceptsToken) throw new Error('fixture refused')
      onePassword = 'unlocked'
    },
    async vaultUnlock(value, connection) {
      credentialPairs.push(['bitwarden', connection])
      calls.push(['unlock', 'bitwarden', value === token])
    },
    async vaultTokenClear(provider) { calls.push(['clear', provider]); onePassword = 'locked' },
    async vaultItems(query, provider) {
      calls.push(['items', query, provider])
      return { items: [{ id: item, name: 'Fixture item', vault: 'Fixture vault', fields: [
        { selector: 'password', label: 'Password' },
        { selector: sectionField, label: 'Password', section: 'Fixture section' },
      ] }] }
    },
    async secretSourceSet(row) {
      calls.push(['mapping', row.provider, row.connection, row.name, row.item === item, row.field === sectionField])
    },
  }
  const credentialPairs = []
  const props = { roster, actions, run: async promise => { try { await promise; return true } catch { return false } },
    Section: ({ title, children }) => react.createElement('section', {}, title, ...children) }
  const paint = (node, path) => {
    if (Array.isArray(node)) return node.map((child, index) => paint(child, path + '/' + index))
    if (!node || typeof node !== 'object') return node
    if (node.props.key !== undefined) path += '/' + node.props.key
    if (typeof node.type === 'function') {
      current = { path: path + '/' + node.type.name, index: 0 }
      return paint(node.type(node.props), current.path)
    }
    if (node.props.ref) {
      if (!inputs.has(path)) inputs.set(path, { value: '' })
      node.props.ref.current = inputs.get(path)
    }
    return { ...node, props: { ...node.props, children: paint(node.props.children, path) } }
  }
  const render = () => {
    const tree = paint(react.createElement(module.exports.SecretsPage, props), '')
    for (const effect of effects.splice(0)) effect()
    assert.equal(text(tree).includes(token), false)
    return tree
  }
  const ready = async () => { render(); await tick(); return render() }
  const find = predicate => walk(render(), predicate)[0]
  const label = name => find(node => node.props['aria-label'] === name)
  const button = name => find(node => node.type === 'button' && text(node) === name)
  const fill = (name, value) => label(name).props.onChange({ target: { value } })
  const enter = () => {
    const input = label('1Password service account token').props
    assert.equal(input.value, undefined)
    input.ref.current.value = token
    return input.ref.current
  }
  const choose = async () => {
    await ready()
    fill('Vault provider', 'onepassword')
    await ready()
  }
  return { ready, render, find, label, button, fill, enter, choose, calls, item, sectionField,
    credentialPairs, accept: () => { acceptsToken = true },
    async pollAs(provider, connection) { polledPair = { provider, connection }; await poll(); render() } }
}

test('Settings sets, replaces and clears an uncontrolled local token and clears the input on refusal', async () => {
  const h = fixture()
  await h.choose()
  assert.equal(h.label('Bitwarden master password'), undefined)
  const refused = h.enter()
  await h.button('Set token').props.onClick()
  assert.equal(refused.value === '', true)
  await h.ready()
  h.accept()
  const entered = h.enter()
  await h.button('Set token').props.onClick()
  assert.equal(entered.value === '', true)
  await h.ready()
  const replaced = h.enter()
  await h.button('Replace token').props.onClick()
  assert.equal(replaced.value === '', true)
  await h.ready()
  await h.button('Clear token').props.onClick()
  await h.ready()
  assert.equal(h.button('Add a vault key'), undefined)
  assert.deepEqual(h.calls, [['set', 'onepassword', true], ['set', 'onepassword', true],
    ['set', 'onepassword', true], ['clear', 'onepassword']])
})

for (const [provider, connection, label] of [
  ['bitwarden', 'work', 'Bitwarden master password'],
  ['onepassword', 'work', '1Password service account token'],
]) {
  test(`a status poll changing the credential pair to ${provider}/${connection} drops typed text before Enter`, async () => {
    const h = fixture()
    await h.choose()
    const input = h.enter()
    await h.pollAs(provider, connection)
    const after = h.label(label).props
    assert.equal(after.ref.current === input, false)
    assert.equal(after.ref.current.value === '', true)
    after.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault() {} })
    await tick()
    assert.deepEqual(h.calls, [])
    if (provider === 'onepassword') h.enter()
    else after.ref.current.value = randomBytes(24).toString('hex')
    await h.button(provider === 'onepassword' ? 'Set token' : 'Unlock').props.onClick()
    assert.deepEqual(h.credentialPairs, [[provider, connection]])
  })
}

test('the picker groups items by vault and distinguishes duplicate field labels by section', async () => {
  const h = fixture()
  await h.choose()
  h.accept()
  h.enter()
  await h.button('Set token').props.onClick()
  await h.ready()
  h.button('Add a vault key').props.onClick()
  h.fill('Key name', 'service-key')
  await h.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.equal(h.find(node => node.type === 'optgroup').props.label, 'Fixture vault')
  h.fill('Vault item', h.item)
  assert.match(text(h.render()), /Password \(Fixture section\)/)
  h.fill('Vault field', h.sectionField)
  await h.button('Save key').props.onClick()
  assert.deepEqual(h.calls.slice(-2), [['items', '', 'onepassword'],
    ['mapping', 'onepassword', 'onepassword', 'SERVICE_KEY', true, true]])
})

test('a mapped provider cannot be switched and a remote or Cloud page hides token entry', async () => {
  const remote = fixture({ hostname: 'fixture.invalid', mapped: true })
  await remote.ready()
  assert.equal(remote.label('Vault provider').props.disabled, true)
  assert.equal(remote.label('Vault provider').props.value, 'onepassword')
  assert.equal(remote.label('1Password service account token'), undefined)
  assert.equal(remote.button('Set token'), undefined)
  const cloud = fixture({ cloud: true, mapped: true })
  assert.match(text(await cloud.ready()), /1Password is unavailable in Automagik Cloud\./)
  assert.equal(cloud.label('1Password service account token'), undefined)
})
