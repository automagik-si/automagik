import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const provider = 'macos-keychain'
const connection = 'login-keychain'
const service = ' fixture  service  '
const account = '  fixture account '
const item = JSON.stringify(['/Users/Fixture/Library/Keychains/login.keychain-db', service, account])
const snapshot = 'fixture-snapshot'
const { outputFiles } = await build({
  stdin: { contents: `
    export { SecretsPage, SecretCard } from './src/client/secret-card.js'
    export { teamActions } from './src/client/team-actions.js'
  `, resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
})
const find = (node, match) => Array.isArray(node) ? node.flatMap(child => find(child, match))
  : node && typeof node === 'object' ? [...(match(node) ? [node] : []), ...find(node.props.children, match)] : []
const text = node => Array.isArray(node) ? node.map(text).join('')
  : node && typeof node === 'object' ? text(node.props.children) : String(node ?? '')
const same = (actual, expected) => assert.ok(JSON.stringify(actual) === JSON.stringify(expected), 'expected exact request fields')

function setup({ hostname = 'localhost', platform = 'darwin', card = false } = {}) {
  const module = { exports: {} }
  const hooks = new Map()
  const effects = []
  const calls = []
  let current, saved
  let chosen = 'bitwarden'
  let state = 'locked'
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
      const effect = slot(undefined)
      if (effect.deps?.length === deps.length && deps.every((value, index) => Object.is(value, effect.deps[index]))) return
      effects.push(() => { effect.stop?.(); effect.deps = deps; effect.stop = run() })
    },
    useLayoutEffect() {},
  }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    require: name => name === 'react' ? react : { MarkdownText: ({ text }) => text },
    document: { activeElement: null, querySelector: () => null, addEventListener() {}, removeEventListener() {} },
    location: { protocol: 'http:', hostname }, URL, URLSearchParams, AbortController,
    setTimeout: () => 1, clearTimeout() {},
  })
  const request = {
    id: 'fixture-request', sessionId: 'fixture-chat', name: 'FIXTURE_KEY', purpose: 'Use the fixture', source: 'vault',
    shell: 'bash', workdir: '/fixture', command: 'fixture-command', commandDigest: 'a'.repeat(64), kind: 'allow', status: 'pending',
  }
  const roster = { byId: {}, bots: [], secrets: [], secretSourcesPresent: true, secretSources: { rows: [] } }
  const actions = module.exports.teamActions({
    after: promise => promise,
    async call(endpoint, body) {
      if (endpoint === 'vault-status') {
        chosen = body?.provider ?? chosen
        const unsupported = chosen === provider && platform !== 'darwin'
        return { provider: chosen, providers: ['bitwarden', provider], connection,
          state: unsupported ? 'unavailable' : state, ...(unsupported ? { reason: 'macOS Keychain needs macOS.' } : {}) }
      }
      calls.push(endpoint)
      switch (endpoint) {
        case 'vault-unlock': same(body, { provider }); state = 'unlocked'; return true
        case 'vault-lock': same(body, { provider }); state = 'locked'; return true
        case 'vault-items':
          same(body, { provider, service, account })
          return { items: [{ id: item, service, account, fields: [{ selector: 'password', label: 'Password' }] }] }
        case 'secret-source-set':
          same(body, { name: 'FIXTURE_KEY', purpose: '', connection, item, field: 'password', scope: 'all', provider })
          saved = JSON.parse(JSON.stringify(body))
          return true
        case 'secret-source-detail': return {
          provider, item: saved?.item ?? item, field: 'password', commandDigest: request.commandDigest, snapshot,
        }
        case 'secret-allow':
          same(body, { requestId: request.id, commandDigest: request.commandDigest, snapshot })
          return true
        default: assert.fail('unexpected endpoint')
      }
    },
  })
  const cardProps = { actions, roster, bot: { id: 'fixture', name: 'Fixture' }, request, sessionId: request.sessionId, inline: true }
  const settingsProps = { actions, roster, run: async promise => await promise,
    Section: ({ title, children }) => react.createElement('section', {}, title, ...children) }
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
    const tree = paint(react.createElement(card ? module.exports.SecretCard : module.exports.SecretsPage,
      card ? cardProps : settingsProps), '')
    for (const effect of effects.splice(0)) effect()
    return tree
  }
  const ready = async () => { render(); await setImmediate(); return render() }
  const by = predicate => find(render(), predicate)[0]
  const label = (name, type) => by(node => node.props['aria-label'] === name && (!type || node.type === type))
  const button = name => by(node => node.type === 'button' && text(node) === name)
  const fill = (name, value, type) => label(name, type).props.onChange({ target: { value } })
  return {
    render, ready, label, button, fill, calls, roster,
    submit: () => by(node => node.type === 'form').props.onSubmit({ preventDefault() {} }),
    async choose() { await ready(); fill('Vault provider', provider); return ready() },
    async viewCard() { card = true; return ready() },
  }
}

test('Settings unlocks without a password and maps exact service and account for the private card', async () => {
  const h = setup()
  const settings = await h.choose()
  assert.ok(text(settings).includes('macOS may ask on this Mac. Choose “Allow”, not “Always Allow”.'))
  assert.equal(find(settings, node => node.type === 'input' && node.props.type === 'password').length, 0)
  await h.button('Unlock').props.onClick()
  await h.ready()
  h.button('Add a vault key').props.onClick()
  h.fill('Key name', 'FIXTURE_KEY')
  assert.equal(h.button('Find').props.disabled, true)
  h.fill('Service', service, 'input')
  h.fill('Account', account, 'input')
  assert.equal(h.label('Service', 'input').props.value, service)
  assert.equal(h.label('Account', 'input').props.value, account)
  assert.equal(h.button('Save key').props.disabled, true)
  await h.submit()
  assert.equal(h.label('Vault field').props.value, 'password')
  assert.equal(h.button('Save key').props.disabled, false)
  await h.button('Save key').props.onClick()
  await h.button('Lock').props.onClick()
  assert.deepEqual(h.calls, ['vault-unlock', 'vault-items', 'secret-source-set', 'vault-lock'])

  const card = await h.viewCard()
  assert.ok(text(card).includes('Provider: macOS Keychain'))
  assert.ok(text(card).includes('Field: Password'))
  assert.equal(text(h.label('Service', 'pre')), service)
  assert.equal(text(h.label('Account', 'pre')), account)
  assert.equal(text(card).includes('/Library/Keychains/'), false)
  assert.equal(JSON.stringify(h.roster).includes(item), false)
  assert.equal(h.button('Allow').props.disabled, false)
  h.button('Allow').props.onClick()
  await setImmediate()
  assert.deepEqual(h.calls.slice(-2), ['secret-source-detail', 'secret-allow'])
})

test('Linux lists the provider with its reason and remote Settings cannot open the gate', async () => {
  const linux = setup({ platform: 'linux' })
  const settings = await linux.choose()
  assert.ok(text(settings).includes('macOS Keychain'))
  assert.ok(text(settings).includes('macOS Keychain needs macOS.'))
  // The reason is the readable hint off macOS; the Mac-only dialog advice is not shown.
  assert.ok(text(settings).includes('Unavailable'))
  assert.ok(!text(settings).includes('Always Allow'))
  assert.equal(linux.button('Unlock'), undefined)
  assert.deepEqual(linux.calls, [])

  const remote = setup({ hostname: 'fixture.invalid' })
  const page = await remote.choose()
  assert.ok(text(page).includes('Unlock the vault in Settings on this computer.'))
  assert.equal(remote.button('Unlock'), undefined)
  assert.deepEqual(remote.calls, [])
})
