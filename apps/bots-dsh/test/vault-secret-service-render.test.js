import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: { contents: `
    export { SecretsPage, SecretCard } from './src/client/secret-card.js'
    export { teamActions } from './src/client/team-actions.js'
  `, resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
})

const provider = 'secret-service'
const same = (a, b) => assert.equal(JSON.stringify(a) === JSON.stringify(b), true, 'rendered actions send only the selected handle or snapshot')
const find = (node, match) => Array.isArray(node) ? node.flatMap(child => find(child, match))
  : node && typeof node === 'object' ? [...(match(node) ? [node] : []), ...find(node.props.children, match)] : []
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props.children) : String(node ?? '')

function setup({ hostname = 'localhost', card = false, invalidDetail = false } = {}) {
  const [label, collection, locked, handle, alternate] = Array.from({ length: 5 }, () => randomBytes(16).toString('hex'))
  const created = '1710000000'
  const module = { exports: {} }
  const hooks = new Map()
  const calls = []
  let current
  let selected = 'bitwarden'
  let state = 'locked'
  const effects = []
  const slot = initial => {
    const key = current.path + ':' + current.index++
    if (!hooks.has(key)) hooks.set(key, { value: initial })
    return hooks.get(key)
  }
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
    setTimeout() {}, clearTimeout() {},
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
        return { provider: selected, providers: ['bitwarden', provider], connection: provider, state }
      }
      if (endpoint === 'vault-unlock') { same(body, { provider }); state = 'unlocked' }
      if (endpoint === 'vault-lock') { same(body, { provider }); state = 'locked' }
      if (endpoint === 'vault-items') {
        same(body, { search: '', provider })
        return { items: [
          { handle, name: label, collection, field: 'secret', created },
          { handle: alternate, name: label, collection, field: 'secret', created: '1710000001' },
          { collection: locked, locked: true },
        ] }
      }
      if (endpoint === 'secret-source-set') {
        same(body, { name: 'FIXTURE_KEY', purpose: '', scope: 'all', provider, handle })
      }
      if (endpoint === 'secret-source-detail') return {
        provider, name: label, collection, field: 'secret', created: invalidDetail ? undefined : created,
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
      return paint(node.type(node.props), current.path)
    }
    return { ...node, props: { ...node.props, children: paint(node.props.children, path) } }
  }
  const render = () => {
    const root = card ? module.exports.SecretCard : module.exports.SecretsPage
    const tree = paint(react.createElement(root, props), '')
    for (const effect of effects.splice(0)) effect()
    return tree
  }
  const ready = async () => { render(); await setImmediate(); return render() }
  const by = predicate => find(render(), predicate)[0]
  const input = name => by(node => node.props['aria-label'] === name)
  const button = name => by(node => node.type === 'button' && text(node) === name)
  const fill = (name, value) => input(name).props.onChange({ target: { value } })
  return { ready, render, input, button, fill, calls, label, collection, locked, handle,
    search: () => by(node => node.type === 'form').props.onSubmit({ preventDefault() {} }),
    async choose() { await ready(); fill('Vault provider', provider); await ready() },
  }
}

test('local Settings opens without a credential, distinguishes duplicate labels and saves only a handle', async () => {
  const h = setup()
  await h.choose()
  assert.equal(find(h.render(), node => node.type === 'input').length, 0)
  await h.button('Unlock').props.onClick()
  await h.ready()
  h.button('Add a vault key').props.onClick()
  h.fill('Key name', 'FIXTURE_KEY')
  await h.search()
  const options = find(h.input('Vault item'), node => node.type === 'option')
  const labels = options.filter(option => text(option).includes(h.label))
  assert.equal(labels.length, 2)
  assert.equal(labels.every(option => text(option).includes(h.collection) && /Created: /.test(text(option))), true)
  assert.equal(text(labels[0]) !== text(labels[1]), true)
  assert.equal(options.some(option => option.props.disabled && text(option).includes(h.locked)), true)
  assert.equal(h.button('Save key').props.disabled, true)
  await h.fill('Vault item', h.handle)
  assert.equal(h.input('Vault field'), undefined)
  await h.button('Save key').props.onClick()
  await h.button('Lock').props.onClick()
  assert.deepEqual(h.calls.filter(call => call !== 'vault-status'), ['vault-unlock', 'vault-items', 'secret-source-set', 'vault-lock'])
})

test('remote Settings renders local-only guidance without an unlock button', async () => {
  const h = setup({ hostname: 'example.invalid' })
  await h.choose()
  assert.equal(h.button('Unlock'), undefined)
  assert.match(text(h.render()), /Unlock the vault in Settings on this computer/)
})

test('card renders person-only item details and approves the displayed snapshot', async () => {
  const h = setup({ card: true })
  await h.ready()
  const displayed = text(h.render())
  assert.equal(displayed.includes(h.label) && displayed.includes(h.collection), true)
  assert.match(displayed, /Secret Service \(GNOME Keyring\)/)
  assert.match(displayed, /Created: /)
  h.button('Allow').props.onClick()
  await setImmediate()
  assert.deepEqual(h.calls, ['secret-source-detail', 'secret-allow'])

  const incomplete = setup({ card: true, invalidDetail: true })
  await incomplete.ready()
  assert.equal(incomplete.button('Allow').props.disabled, true)
  assert.equal(text(incomplete.render()).includes(incomplete.label), false)
})
