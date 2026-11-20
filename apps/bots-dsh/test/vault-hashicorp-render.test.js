import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { privateInputs } from '../../vault-dsh/test/fixtures/fake-vault.mjs'

const { outputFiles } = await build({
  stdin: { contents: `
    export { SecretsPage, SecretCard } from './src/client/secret-card.js'
    export { teamActions } from './src/client/team-actions.js'
  `, resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
})

const provider = 'hashicorp-vault'
const same = (actual, expected) => assert.equal(JSON.stringify(actual) === JSON.stringify(expected), true)
const find = (node, match) => Array.isArray(node) ? node.flatMap(child => find(child, match))
  : node && typeof node === 'object' ? [...(match(node) ? [node] : []), ...find(node.props.children, match)] : []
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props.children) : String(node ?? '')

function setup({ hostname = 'localhost', card = false } = {}) {
  const input = privateInputs(randomBytes(32).toString('hex'))
  const module = { exports: {} }
  const hooks = new Map()
  const inputNodes = new Map()
  const calls = []
  let current
  let selected = 'bitwarden'
  let connection
  let state = 'locked'
  let mismatch = false
  let poll
  const slot = initial => {
    const key = current.path + ':' + current.index++
    if (!hooks.has(key)) hooks.set(key, { value: initial })
    return hooks.get(key)
  }
  const effects = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const state = slot(initial)
      return [state.value, value => { state.value = typeof value === 'function' ? value(state.value) : value }]
    },
    useRef: initial => slot({ current: initial }).value,
    useId: () => 'fixture-id',
    useEffect(run, deps) {
      const state = slot(undefined)
      if (state.deps?.length === deps.length && deps.every((value, index) => Object.is(value, state.deps[index]))) return
      effects.push(() => { state.stop?.(); state.deps = deps; state.stop = run() })
    },
    useLayoutEffect() {},
  }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    require: name => name === 'react' ? react : { MarkdownText: ({ text }) => text },
    document: { activeElement: null, querySelector: () => null, addEventListener() {}, removeEventListener() {} },
    location: { protocol: 'http:', hostname }, URL, URLSearchParams, AbortController,
    setTimeout: callback => { poll = callback; return callback },
    clearTimeout: callback => { if (poll === callback) poll = undefined },
  })
  const roster = { byId: {}, bots: [], secrets: [], secretSourcesPresent: true, secretSources: { rows: [] } }
  const bot = { id: 'fixture', name: 'Fixture' }
  const request = { id: 'fixture-request', sessionId: 'fixture', name: 'FIXTURE_KEY', purpose: 'Use the fixture', source: 'vault',
    shell: 'bash', workdir: '/fixture', command: 'fixture-command', commandDigest: 'a'.repeat(64), kind: 'allow', status: 'pending' }
  const actions = module.exports.teamActions({
    after: promise => promise,
    async call(endpoint, body) {
      calls.push(endpoint)
      if (endpoint === 'vault-status') {
        selected = body?.provider ?? selected
        return { provider: selected, providers: ['bitwarden', 'onepassword', provider], connection,
          state, ...(mismatch ? { mismatch, reason: 'This mapping belongs to another Vault server; connect to that server or map again.' } : {}) }
      }
      if (endpoint === 'vault-token-set') {
        same(body, { provider, token: input.token, address: input.address, namespace: input.namespace })
        connection = 'hv:' + '1'.repeat(32)
        state = 'unlocked'
      }
      if (endpoint === 'vault-lock') { same(body, { provider }); state = 'locked' }
      if (endpoint === 'vault-items') {
        same(body, { provider, mount: input.mount, folder: body.folder })
        return { items: body.folder === '' ? [{ id: 'folder', name: 'folder/', folder: true }]
          : [{ id: 'folder/' + input.path, name: input.path, folder: false }] }
      }
      if (endpoint === 'vault-fields') {
        same(body, { provider, mount: input.mount, path: 'folder/' + input.path })
        return { fields: [input.field, ' ' + input.field + ' '] }
      }
      if (endpoint === 'secret-source-set') {
        same(body, { name: 'FIXTURE_KEY', purpose: '', connection, item: JSON.stringify([input.mount, 'folder/' + input.path]), field: ' ' + input.field + ' ', scope: 'all', provider })
      }
      if (endpoint === 'secret-source-detail') return {
        provider, item: JSON.stringify([input.mount, input.path]), field: input.field,
        commandDigest: request.commandDigest, snapshot: 'fixture-snapshot',
      }
      if (endpoint === 'secret-allow') {
        same(body, { commandDigest: request.commandDigest, snapshot: 'fixture-snapshot', requestId: request.id })
      }
      return true
    },
  })
  const props = card ? { actions, roster, bot, request, sessionId: request.sessionId, inline: true } : {
    actions, roster, run: async promise => await promise, Section: ({ title, children }) => react.createElement('section', {}, title, ...children),
  }
  const paint = (node, path) => {
    if (Array.isArray(node)) return node.map((child, index) => paint(child, path + '/' + index))
    if (!node || typeof node !== 'object') return node
    if (node.props.key !== undefined) path += '/' + node.props.key
    if (typeof node.type === 'function') {
      current = { path: path + '/' + node.type.name, index: 0 }
      const { path: childPath } = current
      return paint(node.type(node.props), childPath)
    }
    if (node.props.ref) {
      if (!inputNodes.has(path)) inputNodes.set(path, { value: '' })
      node.props.ref.current = inputNodes.get(path)
    }
    return { ...node, props: { ...node.props, children: paint(node.props.children, path) } }
  }
  const render = () => {
    const root = card ? module.exports.SecretCard : module.exports.SecretsPage
    const tree = paint(react.createElement(root, props), '')
    for (const effect of effects.splice(0)) effect()
    assert.equal([input.token, input.address, input.namespace, input.value].some(canary => text(tree).includes(canary)), false)
    return tree
  }
  const ready = async () => { render(); await setImmediate(); return render() }
  const by = predicate => find(render(), predicate)[0]
  const label = name => by(node => node.props['aria-label'] === name)
  const button = name => by(node => node.type === 'button' && text(node) === name)
  const fill = (name, value) => label(name).props.onChange({ target: { value } })
  const enter = () => {
    const values = [['Vault address', input.address], ['Vault token', input.token], ['Vault namespace (optional)', input.namespace]]
    return values.map(([name, value]) => {
      const ref = label(name).props.ref.current
      ref.value = value
      return ref
    })
  }
  return { ready, render, label, button, fill, enter, input, calls,
    browse: () => by(node => node.type === 'form').props.onSubmit({ preventDefault() {} }),
    async choose() { await ready(); fill('Vault provider', provider); await ready() },
    async pollMismatch() { mismatch = true; await poll(); render() },
  }
}

test('Settings connects locally and maps an exact field by browsing mount and folder', async () => {
  const h = setup()
  await h.choose()
  assert.equal(h.label('Vault token').props.type, 'password')
  const inputs = h.enter()
  await h.button('Connect').props.onClick()
  assert.equal(inputs.every(input => input.value === ''), true)
  await h.ready()
  h.button('Add a vault key').props.onClick()
  h.fill('Key name', 'FIXTURE_KEY')
  h.fill('Vault mount', h.input.mount)
  h.browse()
  await setImmediate()
  await h.fill('Vault item', 'folder/')
  assert.equal(h.label('Vault folder (optional)').props.value === 'folder', true)
  await h.fill('Vault item', 'folder/' + h.input.path)
  const field = ' ' + h.input.field + ' '
  assert.equal(find(h.label('Vault field'), node => node.type === 'option').some(node => node.props.value === field), true)
  h.fill('Vault field', field)
  await h.button('Save key').props.onClick()
  assert.deepEqual(h.calls.filter(op => op !== 'vault-status'), ['vault-token-set', 'vault-items', 'vault-items', 'vault-fields', 'secret-source-set'])
  await h.pollMismatch()
  assert.match(text(h.render()), /belongs to another Vault server/)
  assert.equal(h.button('Add a vault key'), undefined)
  await h.button('Lock').props.onClick()
  assert.equal(h.calls.includes('vault-lock'), true)
})

test('remote UI leaves Vault credential entry to the local browser', async () => {
  const h = setup({ hostname: 'example.invalid' })
  await h.choose()
  assert.equal(h.label('Vault token'), undefined)
  assert.match(text(h.render()), /Unlock the vault in Settings on this computer/)
})

test('approval shows HashiCorp Vault and mount/path only in the person-facing card', async () => {
  const h = setup({ card: true })
  await h.ready()
  assert.equal(text(h.render()).includes('Provider: HashiCorp VaultItem: ' + h.input.mount + '/' + h.input.path), true)
  h.button('Allow').props.onClick()
  await setImmediate()
  assert.deepEqual(h.calls, ['secret-source-detail', 'secret-allow'])
})
