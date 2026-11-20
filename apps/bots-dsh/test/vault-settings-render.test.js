import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: { contents: "export { SecretsPage } from './src/client/secret-card.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
})

const visit = (node, matches) => {
  if (Array.isArray(node)) return node.flatMap(child => visit(child, matches))
  if (node === null || typeof node !== 'object') return []
  return [...(matches(node) ? [node] : []), ...visit(node.props.children, matches)]
}
const text = node => Array.isArray(node) ? node.map(text).join('')
  : node === null || typeof node !== 'object' ? String(node ?? '') : text(node.props.children)
const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture({ present = true, readOnly, hostname = 'localhost', protocol = 'http:', initial = 'locked' } = {}) {
  const module = { exports: {} }
  const slots = new Map()
  const effectQueue = []
  const scheduled = new Map()
  let timeout = 0
  let current
  let state = initial
  let unlockFails = true
  let unlockCorrect = false
  const password = randomBytes(32).toString('hex')
  const calls = []
  const mapping = []
  const sample = { id: '00000000-0000-0000-0000-000000000001', name: 'Fixture item',
    fields: [{ selector: 'login.password', label: 'Password' }, { selector: 'field:sample', label: 'sample' }] }
  const slot = initial => {
    const key = current.path + ':' + current.index++
    if (!slots.has(key)) slots.set(key, { value: initial })
    return slots.get(key)
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) { const s = slot(initial); return [s.value, value => { s.value = typeof value === 'function' ? value(s.value) : value }] },
    useRef(initial) { const s = slot({ current: initial }); return s.value },
    useId: () => slot('fixture-id').value,
    useEffect(run, deps) {
      const s = slot({})
      if (s.deps === undefined || deps.some((value, i) => !Object.is(value, s.deps[i]))) {
        effectQueue.push(() => { s.stop?.(); s.deps = deps; s.stop = run() })
      }
    },
    useLayoutEffect() {},
  }
  const location = { protocol, hostname }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    require: name => name === 'react' ? react : { MarkdownText: ({ text }) => text },
    document: { activeElement: null, querySelector: () => null, addEventListener() {}, removeEventListener() {} },
    location, URL, URLSearchParams, AbortController,
    setTimeout(run) { scheduled.set(++timeout, run); return timeout },
    clearTimeout(id) { scheduled.delete(id) },
  })
  const roster = { byId: {}, bots: [], secretSourcesPresent: present, readOnly }
  const actions = {
    async vaultStatus() { return { present: true, state, connection: 'fixture-label' } },
    async vaultUnlock(value) {
      unlockCorrect = value === password
      if (unlockFails) throw new Error('fixture refused')
      state = 'unlocked'
    },
    async vaultLock() { calls.push('lock'); state = 'locked' },
    async vaultItems(search) { calls.push(search); return { items: [sample] } },
    async secretSourceSet(row) { mapping.push(row) },
  }
  const props = { roster, actions, run: async promise => { try { await promise; return true } catch { return false } },
    Section: ({ title, children }) => react.createElement('section', {}, title, ...children) }
  const paint = (node, path) => {
    if (Array.isArray(node)) return node.map((child, i) => paint(child, path + '/' + (child?.props?.key ?? i)))
    if (node === null || typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      current = { path: path + '/' + node.type.name, index: 0 }
      return paint(node.type(node.props), current.path)
    }
    const ref = node.props.ref
    if (ref && !ref.current) ref.current = { value: '' }
    return { ...node, props: { ...node.props, children: paint(node.props.children, path) } }
  }
  const render = () => {
    const tree = paint(react.createElement(module.exports.SecretsPage, props), '')
    for (const effect of effectQueue.splice(0)) effect()
    return tree
  }
  const find = predicate => visit(render(), predicate)[0]
  const button = label => find(node => node.type === 'button' && text(node) === label)
  const input = label => find(node => node.props['aria-label'] === label)
  const fill = (label, value) => input(label).props.onChange({ target: { value } })
  const ready = async () => { render(); await tick(); render() }
  return { render, ready, button, input, fill, find, calls, mapping, sample,
    enterPassword: () => { input('Bitwarden master password').props.ref.current.value = password },
    passwordIsGone: () => input('Bitwarden master password').props.ref.current.value === '',
    unlockCorrect: () => unlockCorrect, allowUnlock: () => { unlockFails = false } }
}

test('only a present service shows the Vault section, and insecure or read-only pages cannot unlock', async () => {
  assert.equal(text(fixture({ present: false }).render()).includes('Vault'), false)
  const insecure = fixture({ hostname: 'fixture.example.test' })
  await insecure.ready()
  assert.equal(insecure.input('Bitwarden master password'), undefined)
  assert.equal(text(insecure.render()).includes('Unlock the vault in Settings on this computer.'), true)
  // RFC 0034 Q10: an HTTPS page on another host (Pocket, remote) may not unlock either.
  const remote = fixture({ hostname: 'fixture.example.test', protocol: 'https:' })
  await remote.ready()
  assert.equal(remote.input('Bitwarden master password'), undefined)
  assert.equal(text(remote.render()).includes('Unlock the vault in Settings on this computer.'), true)
  const readOnly = fixture({ readOnly: 'fixture' })
  await readOnly.ready()
  assert.equal(readOnly.button('Unlock'), undefined)
  assert.equal(readOnly.button('Add a vault key'), undefined)
  const unsigned = fixture({ initial: 'unauthenticated' })
  await unsigned.ready()
  assert.equal(text(unsigned.render()).includes('Not signed in to Bitwarden CLI'), true)
})

test('unlock clears the uncontrolled password on failure and success, then lock hides the picker', async () => {
  const h = fixture()
  await h.ready()
  assert.equal(h.input('Bitwarden master password').props.value, undefined)
  h.enterPassword()
  await h.button('Unlock').props.onClick()
  await h.ready()
  assert.equal(h.unlockCorrect() && h.passwordIsGone(), true)
  h.enterPassword()
  const field = h.input('Bitwarden master password').props.ref.current
  h.allowUnlock()
  await h.button('Unlock').props.onClick()
  await h.ready()
  assert.equal(h.unlockCorrect() && field.value === '', true)
  assert.equal(text(h.render()).includes('Unlocked'), true)
  assert.ok(h.button('Add a vault key'))
  await h.button('Lock').props.onClick()
  await h.ready()
  assert.deepEqual(h.calls, ['lock'])
  assert.equal(h.button('Add a vault key'), undefined)
})

test('the picker uses the selected item id, exact selector, scope and host connection', async () => {
  const h = fixture({ initial: 'unlocked' })
  await h.ready()
  h.button('Add a vault key').props.onClick()
  h.fill('Key name', 'sample-key')
  h.fill('What it is for', 'Use the sample')
  h.fill('Search the vault', 'sample')
  const form = h.find(node => node.type === 'form')
  await form.props.onSubmit({ preventDefault() {} })
  assert.deepEqual(h.calls, ['sample'])
  assert.equal(text(h.render()).includes('Fixture item'), true)
  h.fill('Vault item', h.sample.id)
  h.fill('Vault field', 'field:sample')
  const chosen = visit(h.render(), node => node.type === 'input' && node.props.type === 'radio').at(-1)
  chosen.props.onChange()
  await h.button('Save key').props.onClick()
  assert.equal(JSON.stringify(h.mapping) === JSON.stringify([{
    name: 'SAMPLE_KEY', purpose: 'Use the sample', connection: 'fixture-label',
    item: h.sample.id, field: 'field:sample', scope: [],
  }]), true)
  assert.equal(text(h.render()).includes('Fixture item'), false)
})
